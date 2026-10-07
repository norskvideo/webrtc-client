import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplexClient, ResponseError, WhepClient, WhipClient } from "../src/webrtc";
import {
  ANSWER_SDP,
  FakeFetch,
  FakePeerConnection,
  OFFER_SDP,
  acceptedResponse,
  deferred,
  flush,
  installFakes,
  lastPeerConnection,
  rejectedResponse,
} from "./fakes";

let fetches: FakeFetch;

beforeEach(() => {
  fetches = installFakes();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ENDPOINT = "http://localhost/whep";

function whep() {
  return new WhepClient({ url: ENDPOINT });
}

// Resolves to "pending" or "settled" after letting continuations run.
async function settledState(p: Promise<unknown>) {
  const marker = Symbol("pending");
  const result = await Promise.race([p.then(() => "settled", () => "settled"), flush().then(() => marker)]);
  return result === marker ? "pending" : "settled";
}

describe("WhepClient.start()", () => {
  it("resolves once the answer has been applied", async () => {
    const client = whep();
    const started = client.start();

    const post = await fetches.next("POST");
    expect(post.url).toBe(ENDPOINT);
    expect(post.headers["Content-Type"]).toBe("application/sdp");
    expect(post.body).toBe(OFFER_SDP);
    expect(await settledState(started)).toBe("pending");

    post.respond(acceptedResponse("/session/1"));
    await started;

    const pc = lastPeerConnection();
    expect(pc.localDescription?.sdp).toBe(OFFER_SDP);
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: ANSWER_SDP });
    expect(client.sessionUrl?.toString()).toBe("http://localhost/session/1");
    expect(client.closed).toBe(false);
    expect(pc.closed).toBe(false);
  });

  it("rejects with ResponseError when the server rejects the offer, after raising responseerror", async () => {
    const client = whep();
    const events: string[] = [];
    client.addEventListener("responseerror", (ev) => events.push(`responseerror:${ev.detail.status}`));

    const started = client.start().then(
      () => events.push("resolved"),
      (e) => {
        events.push(`rejected:${e instanceof ResponseError ? e.response.status : String(e)}`);
        throw e;
      },
    );

    const post = await fetches.next("POST");
    post.respond(rejectedResponse(503));

    await expect(started).rejects.toBeInstanceOf(ResponseError);
    expect(events).toEqual(["responseerror:503", "rejected:503"]);
    expect(client.sessionUrl).toBeUndefined();
    expect(lastPeerConnection().remoteDescription).toBeNull();
  });

  it("rejects when the server omits the session Location", async () => {
    const client = whep();
    const started = client.start();
    const post = await fetches.next("POST");
    post.respond(new Response(ANSWER_SDP, { status: 201 }));
    await expect(started).rejects.toThrow(/Location/);
  });

  it("rejects when the request itself fails", async () => {
    const client = whep();
    const started = client.start();
    const post = await fetches.next("POST");
    post.fail(new TypeError("Failed to fetch"));
    await expect(started).rejects.toThrow("Failed to fetch");
  });

  it("applies ICE servers from the Link header when none were configured", async () => {
    const client = whep();
    const started = client.start();
    const post = await fetches.next("POST");
    post.respond(
      acceptedResponse("/session/1", ANSWER_SDP, {
        Link: `<turn:turn.example.com:3478>; rel="ice-server"; username="u"; credential="p"; credential-type="password"`,
      }),
    );
    await started;
    expect(lastPeerConnection().getConfiguration().iceServers).toEqual([
      { urls: ["turn:turn.example.com:3478"], username: "u", credential: "p", credentialType: "password" },
    ]);
  });

  it("sends local ICE candidates to the session as trickle PATCHes", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse("/session/1"));
    await started;

    lastPeerConnection().emitCandidate("candidate:1 1 udp 2113937151 192.168.0.1 50000 typ host", "0", "abcd");
    const patch = await fetches.next("PATCH");
    expect(patch.url).toBe("http://localhost/session/1");
    expect(patch.headers["Content-Type"]).toBe("application/trickle-ice-sdpfrag");
    expect(patch.body).toBe(
      ["m=audio 9 RTP/AVP 0", "a=ice-ufrag:abcd", "a=mid:0", "a=candidate:1 1 udp 2113937151 192.168.0.1 50000 typ host"].join("\r\n"),
    );
    patch.respond(new Response(null, { status: 204 }));
  });

  it("cannot be started twice", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse());
    await started;
    await expect(client.start()).rejects.toThrow(/re-use/);
  });
});

describe("closeSession()", () => {
  it("closes the peer connection before any negotiation has started", async () => {
    const client = whep();
    await client.closeSession();
    expect(client.closed).toBe(true);
    expect(lastPeerConnection().closed).toBe(true);
    expect(fetches.calls).toEqual([]);
  });

  it("closes the peer connection of a client whose offer was rejected, without a DELETE", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(rejectedResponse(409));
    await expect(started).rejects.toBeInstanceOf(ResponseError);

    await client.closeSession();
    expect(lastPeerConnection().closed).toBe(true);
    expect(fetches.byMethod("DELETE")).toEqual([]);
  });

  it("abandons an in-flight offer: aborts the POST, closes the peer connection, and start() resolves", async () => {
    const client = whep();
    const started = client.start();
    const post = await fetches.next("POST");
    expect(await settledState(started)).toBe("pending");

    const closing = client.closeSession();
    expect(client.closed).toBe(true);
    expect(lastPeerConnection().closed).toBe(true);
    expect(post.aborted).toBe(true);

    await closing;
    await expect(started).resolves.toBeUndefined();
    expect(lastPeerConnection().remoteDescription).toBeNull();
    expect(fetches.byMethod("DELETE")).toEqual([]);
  });

  it("abandons a negotiation that is waiting on createOffer", async () => {
    const client = whep();
    const pc = lastPeerConnection();
    pc.pendingOffer = deferred();
    const started = client.start();
    await flush();
    expect(fetches.calls).toEqual([]);

    await client.closeSession();
    pc.pendingOffer.resolve({ type: "offer", sdp: OFFER_SDP });
    await expect(started).resolves.toBeUndefined();
    expect(fetches.calls).toEqual([]);
    expect(pc.localDescription).toBeNull();
  });

  it("deletes a session whose offer was accepted after the client was closed, and does not apply the answer", async () => {
    const client = whep();
    const started = client.start();
    const post = await fetches.next("POST");

    // The response arrives, but the client is closed before it gets to look at it.
    post.respond(acceptedResponse("/session/late"));
    const closing = client.closeSession();

    const del = await fetches.next("DELETE");
    expect(del.url).toBe("http://localhost/session/late");
    del.respond(new Response(null, { status: 200 }));

    await closing;
    await expect(started).resolves.toBeUndefined();
    expect(lastPeerConnection().remoteDescription).toBeNull();
    expect(lastPeerConnection().localDescription).toBeNull();
    expect(client.sessionUrl).toBeUndefined();
    expect(fetches.byMethod("DELETE")).toHaveLength(1);
  });

  it("closes the peer connection immediately and then deletes an established session", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse("/session/1"));
    await started;

    const closing = client.closeSession();
    expect(lastPeerConnection().closed).toBe(true);
    expect(client.sessionUrl).toBeUndefined();

    const del = await fetches.next("DELETE");
    expect(del.url).toBe("http://localhost/session/1");
    expect(await settledState(closing)).toBe("pending");
    del.respond(new Response(null, { status: 200 }));
    await closing;
  });

  it("sends DELETE only once under repeated or concurrent calls", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse("/session/1"));
    await started;

    const first = client.closeSession();
    const second = client.closeSession();
    const del = await fetches.next("DELETE");
    del.respond(new Response(null, { status: 200 }));
    await Promise.all([first, second]);
    await client.closeSession();
    expect(fetches.byMethod("DELETE")).toHaveLength(1);
  });

  it("sends no candidates after close and tolerates an aborted PATCH", async () => {
    const client = whep();
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse("/session/1"));
    await started;
    const pc = lastPeerConnection();

    pc.emitCandidate("candidate:1 1 udp 1 10.0.0.1 1 typ host");
    const patch = await fetches.next("PATCH");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const closing = client.closeSession();
      expect(patch.aborted).toBe(true);
      (await fetches.next("DELETE")).respond(new Response(null, { status: 200 }));
      await closing;

      pc.emitCandidate("candidate:2 1 udp 1 10.0.0.2 2 typ host");
      await flush();
      // Only the original POST, the one PATCH and the DELETE.
      expect(fetches.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"]);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("lets a fresh client take over after closing the old one mid-negotiation", async () => {
    const stale = whep();
    const staleStart = stale.start();
    const stalePost = await fetches.next("POST");

    await stale.closeSession();
    const fresh = whep();
    const freshStart = fresh.start();
    const freshPost = await fetches.next("POST");
    expect(freshPost).not.toBe(stalePost);

    freshPost.respond(acceptedResponse("/session/2"));
    await Promise.all([staleStart, freshStart]);

    const [stalePc, freshPc] = FakePeerConnection.instances;
    expect(stalePc.closed).toBe(true);
    expect(stalePc.remoteDescription).toBeNull();
    expect(freshPc.remoteDescription?.sdp).toBe(ANSWER_SDP);
    expect(fresh.sessionUrl?.toString()).toBe("http://localhost/session/2");
  });
});

describe("DuplexClient.start()", () => {
  it("awaits negotiation and rejects when the offer is rejected", async () => {
    const client = new DuplexClient({ url: ENDPOINT });
    const started = client.start();
    (await fetches.next("POST")).respond(rejectedResponse(500));
    await expect(started).rejects.toBeInstanceOf(ResponseError);
  });

  it("resolves once the answer has been applied", async () => {
    const client = new DuplexClient({ url: ENDPOINT });
    const started = client.start();
    (await fetches.next("POST")).respond(acceptedResponse("/session/d"));
    await started;
    expect(lastPeerConnection().remoteDescription?.sdp).toBe(ANSWER_SDP);
  });
});

describe("WhipClient.start()", () => {
  it("rejects when the offer is rejected", async () => {
    const client = new WhipClient({ url: ENDPOINT });
    client.media = { getTracks: () => [] } as unknown as MediaStream;
    const started = client.start();
    (await fetches.next("POST")).respond(rejectedResponse(500));
    await expect(started).rejects.toBeInstanceOf(ResponseError);
  });
});
