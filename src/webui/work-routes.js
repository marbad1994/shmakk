// Routes for the work pipeline: the browser preview, intake (request → tasks),
// show-and-tell recordings, and review-gated plans. Registered by api.js.

const preview = require('./preview');

function registerWorkRoutes(add, app, { HttpError, ws }) {
  // Manager errors carry a status; surface them as HTTP errors.
  const wrap = (fn) => async (ctx) => {
    try { return await fn(ctx); } catch (e) { if (e && e.status && !(e instanceof HttpError)) throw new HttpError(e.status, e.message); throw e; }
  };

  // ── browser preview ─────────────────────────────────────────────────────

  // A signed hand-off link for the preview proxy. The client joins it with the
  // proxy origin: SHMAKK_PREVIEW_URL when set (reverse proxy in front), else
  // the page's own host on the proxy port.
  add('POST', '/api/preview/link', ({ body }) => {
    if (!app.preview) throw new HttpError(503, 'the preview proxy is not running');
    const target = preview.parseTarget(body.url);
    if (!target) throw new HttpError(400, 'enter an http:// or https:// address');
    return { path: app.preview.link(target.href), port: app.preview.port, origin: app.previewPublicUrl, target: target.href };
  });

  // Reachability from the server's point of view (that is where the proxy runs).
  add('GET', '/api/preview/probe', async ({ query }) => preview.probe(query.url));

  // HTTP servers listening on this machine, for one-click targets.
  add('GET', '/api/preview/servers', async () => ({ servers: await preview.discoverServers({ exclude: app.ownPorts || [] }) }));

  // ── intake: requests → layered tasks ───────────────────────────────────

  add('POST', '/api/intake/translate', wrap(async ({ body }) => {
    const intake = require('../services/intake');
    try {
      return await intake.translate({ root: ws(), requests: body.requests, source: body.source, context: body.context, model: app.settings.modelByMode && app.settings.modelByMode.code });
    } catch (e) { throw new HttpError(400, e.message); }
  }));

  // ── show & tell (recorded in the browser) ─────────────────────────────

  const s2p = () => app.show2plan;
  add('POST', '/api/show2plan', wrap(() => s2p().create()));
  add('GET', '/api/show2plan/:id', wrap(({ params }) => s2p().status(params.id)));
  add('DELETE', '/api/show2plan/:id', wrap(({ params }) => ({ ok: s2p().remove(params.id) })));
  add('POST', '/api/show2plan/:id/frame', wrap(({ params, raw, query }) => s2p().addFrame(params.id, raw, { t: query.t, mark: query.mark === '1', score: query.score, type: query.type })));
  add('POST', '/api/show2plan/:id/audio', wrap(({ params, raw }) => s2p().setAudio(params.id, raw)));
  add('POST', '/api/show2plan/:id/process', wrap(({ params, body }) => s2p().process(params.id, {
    instructions: body.instructions, liveTranscript: body.liveTranscript, durationSec: body.durationSec, mode: body.mode === 'automation' ? 'automation' : 'tasks',
    language: body.language || app.settings.voiceLanguage || undefined, budget: body.budget,
  })));
  add('GET', '/api/show2plan/:id/frames/:file', wrap(({ params }) => {
    const abs = s2p().framePath(params.id, params.file);
    if (!abs) throw new HttpError(404, 'not found');
    return { __binary: require('fs').readFileSync(abs), contentType: /\.png$/.test(abs) ? 'image/png' : /\.webp$/.test(abs) ? 'image/webp' : 'image/jpeg' };
  }));

  // ── plans ───────────────────────────────────────────────────────────────

  const plans = () => app.plans;
  add('GET', '/api/plans', () => ({ plans: plans().list() }));
  add('POST', '/api/plans', wrap(({ body }) => {
    let assets = null;
    // Screenshots from a show-and-tell session become the plan's own copies.
    if (body.show2planId && app.show2plan) {
      const frames = {};
      for (const t of Array.isArray(body.tasks) ? body.tasks : []) {
        for (const f of (t.evidence && Array.isArray(t.evidence.frames) ? t.evidence.frames : [])) {
          const abs = app.show2plan.framePath(body.show2planId, f);
          if (abs) frames[f] = abs;
        }
      }
      assets = { frames };
    }
    return plans().create({ title: body.title, summary: body.summary, source: body.source, tasks: body.tasks, requireSignoff: body.requireSignoff, origin: body.origin, assets });
  }));
  add('GET', '/api/plans/:id', wrap(({ params }) => plans().get(params.id)));
  add('PATCH', '/api/plans/:id', wrap(({ params, body }) => plans().update(params.id, body)));
  add('DELETE', '/api/plans/:id', wrap(({ params }) => ({ ok: plans().remove(params.id) })));
  add('POST', '/api/plans/:id/run', wrap(({ params }) => plans().run(params.id)));
  add('POST', '/api/plans/:id/pause', wrap(({ params }) => plans().pause(params.id)));
  add('POST', '/api/plans/:id/tasks', wrap(({ params, body }) => plans().addTask(params.id, body)));
  add('PATCH', '/api/plans/:id/tasks/:tid', wrap(({ params, body }) => plans().editTask(params.id, params.tid, body)));
  add('DELETE', '/api/plans/:id/tasks/:tid', wrap(({ params }) => plans().deleteTask(params.id, params.tid)));
  add('POST', '/api/plans/:id/tasks/:tid/move', wrap(({ params, body }) => plans().moveTask(params.id, params.tid, Number(body.delta) || 0)));
  add('POST', '/api/plans/:id/tasks/:tid/approve', wrap(({ params, body }) => plans().approve(params.id, params.tid, body)));
  add('POST', '/api/plans/:id/tasks/:tid/request-changes', wrap(({ params, body }) => plans().requestChanges(params.id, params.tid, body)));
  add('POST', '/api/plans/:id/tasks/:tid/skip', wrap(({ params }) => plans().skip(params.id, params.tid)));
  add('POST', '/api/plans/:id/tasks/:tid/retry', wrap(({ params }) => plans().retry(params.id, params.tid)));
  add('GET', '/api/plans/:id/diff/:file', wrap(({ params }) => ({ diff: plans().diffFor(params.id, params.file) })));
  add('GET', '/api/plans/:id/assets/:file', wrap(({ params }) => {
    const a = plans().assetFor(params.id, params.file);
    return { __binary: a.data, contentType: a.contentType };
  }));
}

module.exports = { registerWorkRoutes };
