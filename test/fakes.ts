import { vi } from "vitest";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let queued microtasks (promise continuations) run.
export async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function invalidState(message: string) {
  return new DOMException(message, "InvalidStateError");
}

export const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 useinbandfec=1\r\n";
export const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

// Just enough RTCPeerConnection for the client: records what was applied and, like a
// browser, rejects further operations once closed.
export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  configuration: RTCConfiguration;
  closed = false;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  transceivers: { kind: string; init?: RTCRtpTransceiverInit }[] = [];
  tracks: MediaStreamTrack[] = [];
  // Resolved by createOffer; replace to hold the offer back.
  pendingOffer: Deferred<RTCSessionDescriptionInit> | undefined;

  constructor(configuration: RTCConfiguration = {}) {
    super();
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  get signalingState() {
    return this.closed ? "closed" : this.remoteDescription ? "stable" : this.localDescription ? "have-local-offer" : "stable";
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw invalidState("The RTCPeerConnection's signalingState is 'closed'.");
    if (this.pendingOffer) return this.pendingOffer.promise;
    return { type: "offer", sdp: OFFER_SDP };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    if (this.closed) throw invalidState("The RTCPeerConnection's signalingState is 'closed'.");
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.closed) throw invalidState("The RTCPeerConnection's signalingState is 'closed'.");
    this.remoteDescription = description;
  }

  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) {
    if (this.closed) throw invalidState("The RTCPeerConnection's signalingState is 'closed'.");
    this.transceivers.push({ kind, init });
  }

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }

  getConfiguration() {
    return this.configuration;
  }

  setConfiguration(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  close() {
    this.closed = true;
  }

  // Simulate the browser finding a local ICE candidate.
  emitCandidate(candidate: string, sdpMid = "0", usernameFragment = "ufrag") {
    const ev = new Event("icecandidate") as any;
    ev.candidate = { candidate, sdpMid, usernameFragment, sdpMLineIndex: 0 };
    this.dispatchEvent(ev);
  }
}

export type FetchCall = {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  aborted: boolean;
  // Complete the request from the test.
  respond: (response: Response) => void;
  fail: (reason: unknown) => void;
};

// A fetch whose requests are completed by the test; an aborted request rejects with
// AbortError like the real thing.
export class FakeFetch {
  calls: FetchCall[] = [];
  private waiters: ((call: FetchCall) => void)[] = [];

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const result = deferred<Response>();
    const signal = init.signal ?? undefined;
    const call: FetchCall = {
      method: init.method ?? "GET",
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init.body === "string" ? init.body : null,
      headers: { ...((init.headers as Record<string, string>) ?? {}) },
      signal,
      aborted: false,
      respond: result.resolve,
      fail: result.reject,
    };
    if (signal) {
      const onAbort = () => {
        call.aborted = true;
        result.reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    this.calls.push(call);
    for (const waiter of this.waiters.splice(0)) waiter(call);
    return result.promise;
  };

  // The next request to arrive (or one already made but not yet awaited by anyone).
  async next(expectedMethod?: string): Promise<FetchCall> {
    const call = await new Promise<FetchCall>((resolve) => {
      const unclaimed = this.calls.find((c) => !(c as any).claimed);
      if (unclaimed) resolve(unclaimed);
      else this.waiters.push(resolve);
    });
    (call as any).claimed = true;
    if (expectedMethod && call.method !== expectedMethod) {
      throw new Error(`Expected ${expectedMethod} request, got ${call.method} ${call.url}`);
    }
    return call;
  }

  byMethod(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

export function acceptedResponse(sessionUrl = "/session/1", answer = ANSWER_SDP, extraHeaders: Record<string, string> = {}) {
  return new Response(answer, {
    status: 201,
    headers: { "Content-Type": "application/sdp", Location: sessionUrl, ...extraHeaders },
  });
}

export function rejectedResponse(status = 503) {
  return new Response(null, { status });
}

// Install the fakes as the globals the client uses; returns the fetch recorder.
export function installFakes() {
  FakePeerConnection.instances = [];
  const fakeFetch = new FakeFetch();
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("fetch", fakeFetch.fetch);
  // Keep test output quiet: the client logs liberally.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  return fakeFetch;
}

export function lastPeerConnection(): FakePeerConnection {
  const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  if (!pc) throw new Error("No RTCPeerConnection has been created");
  return pc;
}
