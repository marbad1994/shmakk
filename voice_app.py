import os
import io
import json
import uuid
import base64
import numpy as np
from datetime import datetime, timedelta
from dotenv import load_dotenv

from flask import Flask, send_file, request, Response
from flask_socketio import SocketIO, emit
import chromadb
from openai import OpenAI
from faster_whisper import WhisperModel
from kokoro import KPipeline
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
import soundfile as sf

from seed_data import CLINIC_DATA

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET", "tobarko-voice-poc")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# --- Config ---
LLM_BASE_URL         = os.getenv("LLM_BASE_URL", "http://localhost:1234/v1")
LLM_API_KEY          = os.getenv("LLM_API_KEY", "lm-studio")
LLM_MODEL            = os.getenv("LLM_MODEL", "gemma-3-1b")
RERANK_MODEL         = os.getenv("RERANK_MODEL", "qwen3-reranker-0.6b")
GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_SECRET") or os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_CALENDAR_ID   = os.getenv("GOOGLE_CALENDAR_ID", "primary")
GOOGLE_TOKEN_FILE    = os.getenv("GOOGLE_TOKEN_FILE", "google_token.json")
GOOGLE_REDIRECT_URI  = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5050/oauth/callback")
GOOGLE_SCOPES        = ["https://www.googleapis.com/auth/calendar"]
SW_PROJECT_ID        = os.getenv("SIGNALWIRE_PROJECT_ID")
SW_API_TOKEN         = os.getenv("SIGNALWIRE_API_TOKEN")
SW_SPACE             = os.getenv("SIGNALWIRE_SPACE")
PUBLIC_URL           = os.getenv("PUBLIC_URL")
RERANK_TOP_N         = 3
RERANK_THRESHOLD     = 0.5
RERANK_ENABLED       = os.getenv("RERANK_ENABLED", "1") == "1"
WHISPER_MODEL_SIZE   = "base"
KOKORO_VOICE         = "af_heart"  # warm female voice — change to bf_emma for British

# --- Init models ---
print("Loading Whisper...")
whisper = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")

print("Loading Kokoro...")
kokoro_pipeline = KPipeline(lang_code="a")  # 'a' = American English, 'b' = British

# --- Init ChromaDB ---
chroma = chromadb.PersistentClient(path="./chroma_store")
collection = chroma.get_or_create_collection("dental_clinic", metadata={"hnsw:space": "cosine"})

# --- Init LLM client ---
llm = OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

# --- Shared session store ---
# keyed by session_id (browser) or CallSid (SignalWire)
sessions = {}


def seed():
    if collection.count() == 0:
        collection.add(
            ids=[d["id"] for d in CLINIC_DATA],
            documents=[d["text"] for d in CLINIC_DATA],
            metadatas=[d["metadata"] for d in CLINIC_DATA],
        )
        print(f"Seeded {len(CLINIC_DATA)} clinic documents.")


# ─── STT ────────────────────────────────────────────────────────────────────

def transcribe(audio_bytes: bytes, sample_rate: int = 16000, raw_pcm: bool = False) -> str:
    if raw_pcm:
        audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        buf = io.BytesIO()
        sf.write(buf, audio_np, sample_rate, format="WAV")
        buf.seek(0)
    else:
        buf = io.BytesIO(audio_bytes)
    segments, _ = whisper.transcribe(buf, language="en", beam_size=3)
    return " ".join(s.text for s in segments).strip()


# ─── RAG + Reranker ─────────────────────────────────────────────────────────

def retrieve(query: str) -> list[dict]:
    r = collection.query(query_texts=[query], n_results=min(10, collection.count()))
    return [
        {"text": doc, "metadata": meta, "similarity": round(1 - dist, 4)}
        for doc, meta, dist in zip(r["documents"][0], r["metadatas"][0], r["distances"][0])
    ]


RERANK_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query"


def _score_candidate(query: str, document: str) -> float:
    """Qwen3-Reranker scores a query/doc pair via yes/no logprobs on a chat completion."""
    prompt = (
        f"<Instruct>: {RERANK_INSTRUCTION}\n"
        f"<Query>: {query}\n"
        f"<Document>: {document}"
    )
    r = llm.chat.completions.create(
        model=RERANK_MODEL,
        messages=[
            {"role": "system",
             "content": "Judge whether the Document meets the requirements based on the Query and the Instruct provided. Answer only \"yes\" or \"no\"."},
            {"role": "user", "content": prompt},
        ],
        max_tokens=1,
        temperature=0,
        logprobs=True,
        top_logprobs=20,
    )
    choice = r.choices[0]
    top = choice.logprobs.content[0].top_logprobs if choice.logprobs and choice.logprobs.content else []
    yes_lp = no_lp = None
    for tok in top:
        t = tok.token.strip().lower()
        if t == "yes" and yes_lp is None:
            yes_lp = tok.logprob
        elif t == "no" and no_lp is None:
            no_lp = tok.logprob
    if yes_lp is None and no_lp is None:
        return 0.0
    if yes_lp is None:
        return 0.0
    if no_lp is None:
        return 1.0
    y = np.exp(yes_lp)
    n = np.exp(no_lp)
    return float(y / (y + n))


def rerank(query: str, candidates: list[dict]) -> list[dict]:
    if not candidates:
        return []
    if not RERANK_ENABLED:
        return candidates[:RERANK_TOP_N]
    try:
        scored = []
        for c in candidates:
            score = _score_candidate(query, c["text"])
            scored.append({**c, "rerank_score": round(score, 4)})
        scored.sort(key=lambda x: x["rerank_score"], reverse=True)
        passed = [c for c in scored if c["rerank_score"] >= RERANK_THRESHOLD]
        return (passed or scored)[:RERANK_TOP_N]
    except Exception as e:
        print(f"Reranker error: {e}")
        return candidates[:RERANK_TOP_N]


# ─── LLM ────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a warm, professional receptionist for Lucerne Dental Practice.
Answer using ONLY the clinic information provided. Never diagnose or give medical advice.
If information is not in the context, say you will check and follow up.
Keep answers short — this is a phone call. One or two sentences maximum.
IMPORTANT: Do NOT say things like "let me check" or "one moment" — booking is handled separately and you will never follow up. If the patient wants to book, the system will collect their details and confirm automatically; you only need to answer non-booking questions.
Always respond in English."""


def get_response(query: str, context: str, history: list) -> str:
    trimmed = history[-6:]
    while trimmed and trimmed[0]["role"] != "user":
        trimmed = trimmed[1:]
    clean = []
    for msg in trimmed:
        if clean and clean[-1]["role"] == msg["role"]:
            continue
        clean.append(msg)
    if clean and clean[-1]["role"] == "user":
        clean.pop()

    messages = [{"role": "system", "content": f"{SYSTEM_PROMPT}\n\nCLINIC INFO:\n{context}"}]
    messages.extend(clean)
    messages.append({"role": "user", "content": query})
    r = llm.chat.completions.create(model=LLM_MODEL, messages=messages, temperature=0.3, max_tokens=150)
    return r.choices[0].message.content.strip()


# ─── TTS ────────────────────────────────────────────────────────────────────

def synthesise(text: str) -> bytes:
    samples = []
    for _, _, audio in kokoro_pipeline(text, voice=KOKORO_VOICE, speed=1.0, split_pattern=r"\n+"):
        samples.append(audio)
    if not samples:
        return b""
    audio_np = np.concatenate(samples)
    buf = io.BytesIO()
    sf.write(buf, audio_np, 24000, format="WAV")
    return buf.getvalue()


# ─── Calendar (OAuth user flow) ─────────────────────────────────────────────

def _oauth_client_config() -> dict:
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [GOOGLE_REDIRECT_URI],
        }
    }


def _load_google_credentials() -> Credentials | None:
    if not os.path.exists(GOOGLE_TOKEN_FILE):
        return None
    try:
        creds = Credentials.from_authorized_user_file(GOOGLE_TOKEN_FILE, GOOGLE_SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleAuthRequest())
            with open(GOOGLE_TOKEN_FILE, "w") as f:
                f.write(creds.to_json())
        return creds
    except Exception as e:
        print(f"Token load failed: {e}")
        return None


def book_appointment(name: str, date_str: str, time_str: str, details: dict | None = None) -> dict:
    details = details or {}
    print(f"[book_appointment] name={name} date={date_str} time={time_str} reason={details.get('reason_for_visit')} email={details.get('email')} phone={details.get('phone')}")
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        print(f"[mock booking] no OAuth credentials configured")
        return {"success": True, "link": None, "mock": True}
    creds = _load_google_credentials()
    if not creds:
        print(f"[mock booking] visit {GOOGLE_REDIRECT_URI.rsplit('/', 1)[0]}/authorize to grant access")
        return {"success": True, "link": None, "mock": True, "needs_auth": True}
    try:
        svc = build("calendar", "v3", credentials=creds)
        start = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
        end = start + timedelta(minutes=30)
        description_parts = []
        if details.get("reason_for_visit"):
            description_parts.append(f"Reason: {details['reason_for_visit']}")
        if details.get("phone"):
            description_parts.append(f"Phone: {details['phone']}")
        if details.get("email"):
            description_parts.append(f"Email: {details['email']}")
        event = {
            "summary": f"Appointment — {name}",
            "description": "\n".join(description_parts),
            "start": {"dateTime": start.isoformat(), "timeZone": "Europe/Zurich"},
            "end": {"dateTime": end.isoformat(), "timeZone": "Europe/Zurich"},
        }
        if details.get("email"):
            event["attendees"] = [{"email": details["email"]}]
        created = svc.events().insert(calendarId=GOOGLE_CALENDAR_ID, body=event).execute()
        return {"success": True, "link": created.get("htmlLink")}
    except Exception as e:
        print(f"Booking failed: {e}")
        return {"success": False, "error": "calendar service unavailable"}


BOOKING_KEYWORDS = (
    "book", "booking", "appointment", "schedule", "scheduling", "reserve",
    "slot", "termin", "rendez-vous",
)


def _user_requested_booking(history: list) -> bool:
    """Only trigger booking extraction when the user has actually asked to book."""
    for m in history:
        if m["role"] != "user":
            continue
        if any(kw in m["content"].lower() for kw in BOOKING_KEYWORDS):
            return True
    return False


BOOKING_EXTRACT_PROMPT = """You extract structured booking info from a conversation between a dental receptionist and a patient.

CRITICAL CONTEXT:
- Today is {today}, which is a {weekday}.
- Day-of-week to date mapping for the NEXT occurrence of each weekday from today:
{weekday_map}

RULES:
1. For a relative weekday like "Wednesday", use the mapping above. Do NOT guess.
2. For "tomorrow" use {tomorrow}. For "today" use {today}.
3. Convert times like "2 PM" → "14:00", "9am" → "09:00", "2:30 pm" → "14:30".
4. If a field is not clearly stated by the patient, use null. Never invent values.
5. reason_for_visit: what the patient wants (checkup, cleaning, toothache, etc.) or null.
6. Output ONLY valid JSON, no prose, no code fences, no markdown.

Schema:
{{"name": string|null, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "email": string|null, "phone": string|null, "reason_for_visit": string|null}}
"""


def _weekday_map(today: datetime) -> str:
    lines = []
    for i in range(1, 8):
        d = today + timedelta(days=i)
        lines.append(f"  - {d.strftime('%A')}: {d.strftime('%Y-%m-%d')}")
    return "\n".join(lines)


def extract_booking(history: list) -> dict:
    """Pull structured booking info from the conversation. Only called once booking intent is confirmed."""
    today = datetime.now()
    sys_prompt = BOOKING_EXTRACT_PROMPT.format(
        today=today.strftime("%Y-%m-%d"),
        weekday=today.strftime("%A"),
        tomorrow=(today + timedelta(days=1)).strftime("%Y-%m-%d"),
        weekday_map=_weekday_map(today),
    )
    convo = "\n".join(
        f"{'Patient' if m['role'] == 'user' else 'Receptionist'}: {m['content']}"
        for m in history
    )
    raw = ""
    empty = {"name": None, "date": None, "time": None, "email": None, "phone": None, "reason_for_visit": None}
    try:
        r = llm.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": f"Conversation:\n{convo}\n\nExtract booking details as JSON."},
            ],
            temperature=0,
            max_tokens=200,
        )
        raw = r.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = json.loads(raw.strip())
        out = {k: data.get(k) for k in empty.keys()}
        print(f"[extract_booking] {out}  (raw: {raw[:120]})")
        return out
    except Exception as e:
        print(f"[extract_booking] FAILED: {e} — raw: {raw!r}")
        return empty


# ─── Shared pipeline ────────────────────────────────────────────────────────

def _format_booking_confirmation(details: dict, result: dict) -> str:
    if result.get("success"):
        dt = datetime.strptime(f"{details['date']} {details['time']}", "%Y-%m-%d %H:%M")
        pretty = dt.strftime("%A, %B %-d at %-I:%M %p")
        reason = f" for a {details['reason_for_visit']}" if details.get("reason_for_visit") else ""
        return f"You're booked, {details['name']}. Your appointment{reason} is confirmed for {pretty}. We'll send a reminder to {details.get('email') or details.get('phone')}. See you then!"
    return f"I'm sorry, I couldn't complete the booking: {result.get('error', 'unknown error')}. Would you like to try a different time?"


BOOKING_FIELD_PROMPTS = [
    ("name",             "Of course — could I have your full name, please?"),
    ("reason_for_visit", "Thanks, {name}. What brings you in — a checkup, cleaning, or something specific?"),
    ("date",             "Got it. What day works for you?"),
    ("time",             "And what time on {date_pretty}?"),
    ("phone",            "Perfect. What's the best phone number to reach you at?"),
    ("email",            "And an email for the confirmation?"),
]


def _next_missing_prompt(details: dict) -> str | None:
    for field, prompt in BOOKING_FIELD_PROMPTS:
        if not details.get(field):
            fmt = {"name": details.get("name") or ""}
            if details.get("date"):
                try:
                    fmt["date_pretty"] = datetime.strptime(details["date"], "%Y-%m-%d").strftime("%A")
                except ValueError:
                    fmt["date_pretty"] = details["date"]
            else:
                fmt["date_pretty"] = "that day"
            return prompt.format(**fmt)
    return None


def run_pipeline(session_id: str, transcript: str, socket_id: str = None):
    session = sessions.setdefault(session_id, {"history": [], "channel": "unknown", "booked": False, "booking_active": False})
    history = session["history"]

    candidates = retrieve(transcript)
    chunks = rerank(transcript, candidates)
    context = "\n\n".join(c["text"] for c in chunks)

    history.append({"role": "user", "content": transcript})

    # Booking flow only activates once the user has clearly asked to book.
    # Once activated, stay in booking mode until all fields are collected and the event is created.
    if not session.get("booked") and not session.get("booking_active"):
        if _user_requested_booking(history):
            session["booking_active"] = True

    booking = None
    response_text = None

    if session.get("booking_active") and not session.get("booked"):
        details = extract_booking(history)
        missing = _next_missing_prompt(details)
        if missing:
            response_text = missing
        else:
            booking = book_appointment(details["name"], details["date"], details["time"], details)
            response_text = _format_booking_confirmation(details, booking)
            if booking.get("success"):
                session["booked"] = True
                session["booking_active"] = False

    if response_text is None:
        response_text = get_response(transcript, context, history[:-1])

    history.append({"role": "assistant", "content": response_text})

    audio_bytes = synthesise(response_text)
    audio_b64 = base64.b64encode(audio_bytes).decode()

    debug = {
        "session_id": session_id,
        "channel": session["channel"],
        "retrieved": len(candidates),
        "after_rerank": len(chunks),
        "chunks": [{"text": c["text"][:80] + "...", "category": c["metadata"].get("category"),
                    "sim": c.get("similarity"), "rerank": c.get("rerank_score")} for c in chunks],
    }

    if socket_id:
        socketio.emit("response", {
            "transcript": transcript,
            "text": response_text,
            "audio": audio_b64,
            "debug": debug,
            "booking": booking,
        }, to=socket_id)

    return response_text, audio_bytes, debug


# ─── Browser WebSocket (chat widget call button) ─────────────────────────────

@socketio.on("connect")
def on_connect():
    sid = request.sid
    sessions[sid] = {"history": [], "channel": "browser"}
    emit("ready", {"session_id": sid})


@socketio.on("disconnect")
def on_disconnect():
    sessions.pop(request.sid, None)


@socketio.on("audio_chunk")
def on_audio_chunk(data):
    sid = request.sid
    audio_bytes = base64.b64decode(data["audio"])
    sample_rate = data.get("sample_rate", 16000)

    socketio.emit("status", {"stage": "transcribing"}, to=sid)
    transcript = transcribe(audio_bytes, sample_rate)

    if not transcript:
        socketio.emit("status", {"stage": "no_speech"}, to=sid)
        return

    socketio.emit("status", {"stage": "thinking", "transcript": transcript}, to=sid)
    run_pipeline(sid, transcript, socket_id=sid)


@socketio.on("text_message")
def on_text_message(data):
    sid = request.sid
    text = data.get("text", "").strip()
    if not text:
        return
    if sid in sessions:
        sessions[sid]["channel"] = "browser_text"

    if text == "__greeting__":
        greeting = "Hello, Lucerne Dental Practice. How can I help you?"
        audio_bytes = synthesise(greeting)
        audio_b64 = base64.b64encode(audio_bytes).decode()
        socketio.emit("response", {
            "transcript": None,
            "text": greeting,
            "audio": audio_b64,
            "debug": None,
            "booking": None,
        }, to=sid)
        return

    run_pipeline(sid, text, socket_id=sid)


# ─── Twilio phone call ───────────────────────────────────────────────────────

@app.route("/twilio/incoming", methods=["POST"])
def twilio_incoming():
    caller = request.form.get("From", "unknown")
    call_sid = request.form.get("CallSid", str(uuid.uuid4()))

    sessions[call_sid] = {"history": [], "channel": "phone", "caller": caller}

    vr = VoiceResponse()
    connect = Connect()
    connect.stream(url=f"wss://{PUBLIC_URL.replace('https://','').replace('http://','')}/twilio/stream/{call_sid}")
    vr.append(connect)
    vr.say("Hello, Lucerne Dental Practice. How can I help you?", voice="alice", language="en-US")
    return Response(str(vr), mimetype="text/xml")


@socketio.on("connect", namespace="/twilio")
def twilio_ws_connect():
    pass


twilio_audio_buffers = {}

@app.route("/twilio/stream/<call_sid>", websocket=True)
def twilio_stream(call_sid):
    from flask_sock import Sock
    pass


@socketio.on("twilio_media")
def on_twilio_media(data):
    call_sid = data.get("call_sid")
    payload = data.get("payload")
    if not payload or not call_sid:
        return

    audio_bytes = base64.b64decode(payload)
    buf = twilio_audio_buffers.get(call_sid, b"")
    buf += audio_bytes
    twilio_audio_buffers[call_sid] = buf

    if len(buf) >= 16000 * 2 * 2:
        twilio_audio_buffers[call_sid] = b""
        transcript = transcribe(buf, sample_rate=8000, raw_pcm=True)
        if transcript:
            response_text, audio_bytes, debug = run_pipeline(call_sid, transcript)
            sid = sessions.get(call_sid, {}).get("browser_sid")
            if sid:
                socketio.emit("response", {
                    "transcript": transcript,
                    "text": response_text,
                    "audio": base64.b64encode(audio_bytes).decode(),
                    "debug": debug,
                }, to=sid)


@app.route("/twilio/status", methods=["POST"])
def twilio_status():
    call_sid = request.form.get("CallSid")
    status = request.form.get("CallStatus")
    if status in ("completed", "failed", "busy", "no-answer"):
        sessions.pop(call_sid, None)
        twilio_audio_buffers.pop(call_sid, None)
    return "", 204


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_file("voice_index.html")


@app.route("/seed")
def seed_route():
    seed()
    return {"documents": collection.count()}


# ─── Google OAuth (one-time consent, then refresh-token forever) ────────────

@app.route("/oauth/authorize")
def oauth_authorize():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return "GOOGLE_CLIENT_ID / GOOGLE_SECRET missing from .env", 500
    flow = Flow.from_client_config(_oauth_client_config(), scopes=GOOGLE_SCOPES)
    flow.redirect_uri = GOOGLE_REDIRECT_URI
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    return Response(
        f'<p>Click to grant calendar access: <a href="{auth_url}">Authorize with Google</a></p>',
        mimetype="text/html",
    )


@app.route("/oauth/callback")
@app.route("/google/callback")
def oauth_callback():
    flow = Flow.from_client_config(_oauth_client_config(), scopes=GOOGLE_SCOPES)
    flow.redirect_uri = GOOGLE_REDIRECT_URI
    flow.fetch_token(authorization_response=request.url)
    with open(GOOGLE_TOKEN_FILE, "w") as f:
        f.write(flow.credentials.to_json())
    return f"Calendar access granted. Token saved to {GOOGLE_TOKEN_FILE}. You can close this tab and start booking."


@app.route("/eval")
def eval_route():
    """Compare retrieval with and without the reranker.

    Usage: /eval?q=do+you+take+walk+ins
    Returns the top-N chunks from vector similarity alone vs. vector + Qwen3 rerank,
    so you can eyeball whether reranking is moving the right passages to the top.
    """
    query = request.args.get("q", "").strip()
    if not query:
        return {"error": "pass ?q=<query>"}, 400

    candidates = retrieve(query)

    baseline = [
        {"rank": i + 1, "category": c["metadata"].get("category"),
         "similarity": c["similarity"], "text": c["text"]}
        for i, c in enumerate(candidates[:RERANK_TOP_N])
    ]

    reranked_raw = []
    try:
        scored = [
            {"candidate": c, "rerank_score": _score_candidate(query, c["text"])}
            for c in candidates
        ]
        scored.sort(key=lambda s: s["rerank_score"], reverse=True)
        reranked_raw = [
            {"rank": i + 1,
             "category": s["candidate"]["metadata"].get("category"),
             "similarity": s["candidate"]["similarity"],
             "rerank_score": round(s["rerank_score"], 4),
             "passed_threshold": s["rerank_score"] >= RERANK_THRESHOLD,
             "text": s["candidate"]["text"]}
            for i, s in enumerate(scored)
        ]
    except Exception as e:
        return {"query": query, "error": f"reranker failed: {e}",
                "baseline": baseline}, 500

    baseline_order = [c["metadata"].get("category") + "::" + c["text"][:40] for c in candidates[:RERANK_TOP_N]]
    rerank_top = reranked_raw[:RERANK_TOP_N]
    rerank_order = [r["category"] + "::" + r["text"][:40] for r in rerank_top]
    order_changed = baseline_order != rerank_order

    return {
        "query": query,
        "retrieved": len(candidates),
        "order_changed_by_rerank": order_changed,
        "baseline_top_n": baseline,
        "reranked_all": reranked_raw,
    }


# ─── REST API (for external clients like shmakk) ──────────────────────────────


@app.route("/api/health")
def api_health():
    return {
        "status": "ok",
        "tts": "kokoro",
        "stt": "whisper",
        "voice": KOKORO_VOICE,
    }


@app.route("/api/tts", methods=["POST"])
def api_tts():
    """Synthesize speech from text. Returns WAV audio.

    JSON body: {"text": "...", "voice": "af_heart" (optional)}
    """
    data = request.get_json(silent=True)
    if not data or not data.get("text"):
        return {"error": "missing 'text' field"}, 400

    text = data["text"].strip()
    if not text:
        return {"error": "empty text"}, 400

    voice = data.get("voice", KOKORO_VOICE)
    try:
        samples = []
        for _, _, audio in kokoro_pipeline(text, voice=voice, speed=1.0, split_pattern=r"\n+"):
            samples.append(audio)
        if not samples:
            return {"error": "no audio produced"}, 500
        audio_np = np.concatenate(samples)
        buf = io.BytesIO()
        sf.write(buf, audio_np, 24000, format="WAV")
        buf.seek(0)
        return send_file(buf, mimetype="audio/wav", as_attachment=False,
                         download_name="speech.wav")
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/stt", methods=["POST"])
def api_stt():
    """Transcribe speech to text. Accepts multipart file upload.

    Form field: 'audio' — WAV file
    Returns: {"transcript": "..."}
    """
    if "audio" not in request.files:
        return {"error": "missing 'audio' file"}, 400

    f = request.files["audio"]
    audio_bytes = f.read()
    if not audio_bytes:
        return {"error": "empty audio"}, 400

    try:
        transcript = transcribe(audio_bytes)
        return {"transcript": transcript}
    except Exception as e:
        return {"error": str(e)}, 500


if __name__ == "__main__":
    seed()
    print("Starting Tobarko voice POC on http://0.0.0.0:5050")
    print("  REST API:  /api/health  /api/tts  /api/stt")
    socketio.run(app, debug=True, host="0.0.0.0", port=5050)
