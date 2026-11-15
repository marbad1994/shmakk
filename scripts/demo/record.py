#!/usr/bin/env python3
"""
shmakk demo recorder — uses Playwright to drive the demo HTML page
while ffmpeg captures the Xvfb display.

Usage: python3 scripts/demo/record.py [--out onlymakk.mp4]
"""

import subprocess, sys, os, time, argparse, shutil, shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENES_HTML = Path(__file__).resolve().parent / "scenes.html"

FPS = 30
WIDTH = 1920
HEIGHT = 1080
DISPLAY = ":99"


def run(cmd, timeout=120, check=True):
    if isinstance(cmd, str):
        print(f"  $ {cmd[:120]}")
    else:
        print(f"  $ {' '.join(shlex.quote(str(x)) for x in cmd)[:120]}")
    return subprocess.run(cmd, shell=isinstance(cmd, str),
                          capture_output=True, text=True,
                          timeout=timeout, check=check)


def is_xvfb_running():
    r = subprocess.run(["pgrep", "-f", f"Xvfb {DISPLAY}"], capture_output=True)
    return r.returncode == 0


def start_xvfb():
    if is_xvfb_running():
        print(f"Xvfb already running on {DISPLAY}")
        return
    print(f"Starting Xvfb on {DISPLAY}...")
    subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", f"{WIDTH}x{HEIGHT}x24",
                      "-ac", "+extension", "RANDR"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    if not is_xvfb_running():
        print("ERROR: Xvfb failed to start")
        sys.exit(1)
    print("Xvfb started.")


def record(out_path: Path):
    tmp_dir = ROOT / "tmp" / "demo"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    raw_mp4 = tmp_dir / "raw.mp4"

    # Clean up previous raw files
    for f in list(tmp_dir.glob("*.webm")) + list(tmp_dir.glob("*.mp4")):
        if f.name != "onlymakk.mp4":
            f.unlink(missing_ok=True)

    start_xvfb()

    env = os.environ.copy()
    env["DISPLAY"] = DISPLAY

    scenes_url = SCENES_HTML.as_uri()

    print(f"Source: {scenes_url}")
    print(f"Output: {out_path}")

    # Start ffmpeg recording in the background
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "x11grab",
        "-framerate", str(FPS),
        "-video_size", f"{WIDTH}x{HEIGHT}",
        "-i", f"{DISPLAY}+0,0",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        str(raw_mp4)
    ]

    print("Starting ffmpeg capture...")
    ffmpeg_proc = subprocess.Popen(ffmpeg_cmd, env=env,
                                   stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
    time.sleep(1)  # let ffmpeg initialize

    if ffmpeg_proc.poll() is not None:
        print("ERROR: ffmpeg exited immediately")
        sys.exit(1)

    # Now run Playwright to drive the demo
    driver_js = f"""
    const {{ chromium }} = require('playwright');

    (async () => {{
        const browser = await chromium.launch({{
            headless: false,
            args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox',
                   '--window-size={WIDTH},{HEIGHT}', '--window-position=0,0']
        }});

        // Make the browser window fill the screen
        const context = await browser.newContext({{
            viewport: {{ width: {WIDTH}, height: {HEIGHT} }},
            deviceScaleFactor: 1,
        }});
        const page = await context.newPage();

        await page.goto('{scenes_url}', {{ waitUntil: 'networkidle' }});

        // Wait for DONE signal or timeout
        const startTime = Date.now();
        const maxDuration = 120_000;
        while (true) {{
            const title = await page.title();
            if (title === 'DONE' || (Date.now() - startTime) > maxDuration) break;
            await new Promise(r => setTimeout(r, 500));
        }}

        console.log('Demo finished. Title:', await page.title());
        console.log('Elapsed:', (Date.now() - startTime) / 1000, 's');

        // Hold the last frame briefly
        await new Promise(r => setTimeout(r, 2000));

        await browser.close();
        console.log('Browser closed.');
    }})();
    """

    driver_script = tmp_dir / "driver.js"
    driver_script.write_text(driver_js)

    print("Launching demo driver...")
    result = subprocess.run(
        ["node", str(driver_script)],
        env=env,
        capture_output=True, text=True,
        timeout=150,
        cwd=str(ROOT)
    )
    print(result.stdout)
    if result.returncode != 0:
        print("STDERR:", result.stderr)
        ffmpeg_proc.terminate()
        ffmpeg_proc.wait()
        sys.exit(1)

    # Give ffmpeg time to flush
    time.sleep(2)
    ffmpeg_proc.terminate()
    try:
        ffmpeg_proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        ffmpeg_proc.kill()
        ffmpeg_proc.wait()

    print(f"Raw capture: {raw_mp4.stat().st_size / 1024 / 1024:.1f} MB")

    # Re-encode for optimal size and faststart
    final_tmp = tmp_dir / "final.mp4"
    run([
        "ffmpeg", "-y",
        "-i", str(raw_mp4),
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(final_tmp)
    ], timeout=300)

    # Move to final destination
    shutil.move(str(final_tmp), str(out_path))

    # Cleanup
    driver_script.unlink(missing_ok=True)
    raw_mp4.unlink(missing_ok=True)

    print(f"\nDone! -> {out_path} ({out_path.stat().st_size / 1024 / 1024:.1f} MB)")


def main():
    parser = argparse.ArgumentParser(description="Record shmakk product demo")
    parser.add_argument("--out", default=str(ROOT / "onlymakk.mp4"),
                        help="Output MP4 path")
    args = parser.parse_args()
    record(Path(args.out))


if __name__ == "__main__":
    main()
