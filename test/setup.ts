// Minimal browser globals so the clients can be constructed under node.
// RTCPeerConnection and fetch are installed per test by the fakes in ./fakes.ts.
(globalThis as any).document = {
  location: { href: "http://localhost/" },
  getElementById: () => null,
};
