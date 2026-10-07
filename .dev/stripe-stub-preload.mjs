// TEST-ONLY. Routes stripe-node's requests to a local stub instead of api.stripe.com.
// Active only when STRIPE_STUB_PORT is set. Use with:
//   NODE_OPTIONS="--import ./.dev/neon-preload.mjs --import ./.dev/stripe-stub-preload.mjs"
// stripe-node's NodeHttpClient calls https.request(...) at request time, so replacing it here
// redirects every Stripe API call; nothing reaches real Stripe.
import http from 'http';
import https from 'https';

const stubPort = process.env.STRIPE_STUB_PORT;

if (stubPort) {
  const realHttpsRequest = https.request;
  https.request = function patchedRequest(options, ...rest) {
    const host = typeof options === 'object' && options !== null ? (options.hostname || options.host) : undefined;
    if (host === 'api.stripe.com') {
      const { agent: _agent, ciphers: _ciphers, ...opts } = options;
      const req = http.request({ ...opts, protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: Number(stubPort) }, ...rest);
      // stripe-node writes the body on the TLS 'secureConnect' event; a plain socket only emits 'connect'.
      req.once('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => socket.emit('secureConnect'));
      });
      return req;
    }
    return realHttpsRequest.call(this, options, ...rest);
  };
  console.log(`[stripe-stub-preload] api.stripe.com -> http://127.0.0.1:${stubPort}`);
}
