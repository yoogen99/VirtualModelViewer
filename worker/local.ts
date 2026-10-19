// This entry point runs only on the PC. The public gateway never forwards this path.
import worker, { cleanup, type Env } from './index';

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === '/__vmv_collect') {
      await cleanup(env);
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env);
  },
};
