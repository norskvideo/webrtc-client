export type WebRtcClientConfig = {
  url: string | URL,
  iceServers?: RTCIceServer[]
};
interface WebRtcClientEventMap {
  "responseerror": CustomEvent<Response>;
}
export class WebRtcClient extends EventTarget {
  cachedCandidates: RTCIceCandidate[] = [];
  endpointUrl: URL;
  sessionUrl: URL | undefined;
  client: RTCPeerConnection;

  constructor(config: WebRtcClientConfig) {
    super();
    this.client = new RTCPeerConnection({
      // Can set STUN/TURN servers directly here if required, but the server will return the configured/requested servers
      iceServers: config.iceServers
    });
    if (!config) {
      throw new Error("Config is required");
    }
    if (!config.url) {
      throw new Error("Must specify endpoint url in config");
    }
    this.endpointUrl = new URL(config.url, document.location.href);

    this.client.addEventListener('icecandidate', (event) => this.handleIceCandidateFromClient(event));
    this.client.addEventListener('iceconnectionstatechange', (event) => this.handleIceConnectionChange(event));
    this.client.addEventListener('track', (event) => this.handleGotTrack(event));
  }

  async handleIceCandidateFromClient(event: RTCPeerConnectionIceEvent) {
    if (!event.candidate || !event.candidate.candidate) {
      console.log("client ice candidate gathering is done", event);
      return;
    }

    if (!this.sessionUrl) {
      console.debug("received candidate before response from session create, caching", event.candidate);
      this.cachedCandidates.push(event.candidate);
      return;
    }

    await this.sendCandidate(event.candidate, false);
  }

  async sendOffer() {
    const client = this.client;
    const localOffer = await client.createOffer();
    await client.setLocalDescription(localOffer);

    console.debug("received local offer, sending to server", localOffer);

    let response = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp"
      },
      body: localOffer.sdp
    });

    if (!response.ok) {
      this.onResponseError(response);
      return;
    }
    this.receiveIceServers(response.headers);
    const sessionUrl = response.headers.get("Location");
    if (sessionUrl == null) {
      throw new Error("Session not provided in Location header");
    }
    this.sessionUrl = new URL(sessionUrl, this.endpointUrl);

    const remoteOffer = await response.text();
    console.log("Got response", { remoteOffer, sessionUrl });

    const remoteResponse = await client.setRemoteDescription({
      type: "answer",
      sdp: remoteOffer,
    });

    console.log("Applied remote description", remoteResponse);
    console.log("Peer connection state", client);

    this.sendCachedCandidates();
  }

  async sendCandidate(candidate: RTCIceCandidate, isCached: boolean) {
    if (isCached) {
      console.log("sending cached client ice candidate", candidate);
    }
    else {
      console.log("sending client ice candidate", candidate);
    }
    if (!this.sessionUrl) {
      throw new Error("Session url not set when expected");
    }

    // The RFCs to look at are
    // - https://www.ietf.org/id/draft-ietf-wish-whip-01.html (ICE and NAT support)
    // - https://www.rfc-editor.org/rfc/rfc8838.html (for the concept, not the implementation)
    // - https://www.rfc-editor.org/rfc/rfc8840.html (for the format of the SDP we need to send here)
    // Note: We *should* be including the ufrag/pwd in this, but we don't have access to the pwd 
    // unless we parse the original offer SDP, so we don't.
    // Note: The defaults for the m= line is audio, even though we're also sending video
    // Again without parsing the original offer SDP, it is impossible to know this
    // The spec says that this is fine and simply 'what you do'
    // Hilariously enough, the webrtc.rs stuff is going to ignore all the values here except the candidate line anyway so *shrug*
    await fetch(this.sessionUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/trickle-ice-sdpfrag"
      },
      body: ["m=audio 9 RTP/AVP 0", // a lie (and everything after the first 0 is ignored, and we only have the second 100 because the sdp parser in webrtc.rs is wrong)
        "a=ice-ufrag:" + candidate.usernameFragment,
        "a=mid:" + candidate.sdpMid, // the only actually important bit
        "a=" + candidate.candidate // and the candidate itself
      ].join('\r\n')
    });
  }

  async sendCachedCandidates() {
    for (const cachedCandidate of this.cachedCandidates) {
      await this.sendCandidate(cachedCandidate, true);
    }
    this.cachedCandidates = [];
  }

  handleIceConnectionChange(event: Event) {
    console.log("client ice connection change", event);
  }

  handleGotTrack(event: RTCTrackEvent) {
    console.log("got track", event);
  }

  async receiveIceServers(headers: Headers) {
    let linkHeader = headers.get('link');
    if (!linkHeader) {
      return;
    }
    let servers: RTCIceServer[] = [];
    let links = linkHeader.split(',');
    for (let link of links) {
      let split = link.split(';').map((x) => x.trim());
      if (split.some(x => x === `rel="ice-server"`)) {
        let urlMatch = split[0].match(/<(.+)>/);
        if (urlMatch) {
          let server: RTCIceServer & { credentialType?: string } = { urls: [urlMatch[1]] };
          for (let f of split) {
            let pair = f.match(/([^=]+)="([^"]+)"/);
            if (pair) {
              switch (pair[1]) {
                case "username":
                  server.username = pair[2];
                  break;
                case "credential":
                  server.credential = pair[2];
                  break;
                case "credential-type":
                  server.credentialType = pair[2];
                  break;
              }
            }
          }
          servers.push(server);
        }
      }
    }
    if (servers.length > 0) {
      let existingIceServers = this.client.getConfiguration().iceServers || [];
      if (existingIceServers.length == 0) {
        console.log("Received ICE server configuration from server, applying", { iceServers: servers })
        this.client.setConfiguration({
          iceServers: servers
        })
      } else {
        console.log("Received ICE server configuration from server but have explicit configuration, ignoring", { existingIceServers, iceServers: servers })
      }
    }

  }

  async onResponseError(response: Response) {
    this.raise('responseerror', new CustomEvent('responseerror', { detail: response }));
  }
  private raise<K extends keyof WebRtcClientEventMap>(type: K, ev: WebRtcClientEventMap[K]) {
    this.dispatchEvent(ev);
  }

  public addEventListener<K extends keyof WebRtcClientEventMap>(type: K, listener: (this: WebRtcClient, ev: WebRtcClientEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  public addEventListener<K extends keyof WebRtcClientEventMap>(type: K, listener: (this: WebRtcClient, ev: WebRtcClientEventMap[K]) => any, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener as any);
  }
  
  public removeEventListener<K extends keyof WebRtcClientEventMap>(type: K, listener: (this: WebRtcClient, ev: WebRtcClientEventMap[K]) => any, options?: boolean | EventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  public removeEventListener<K extends keyof WebRtcClientEventMap>(type: K, listener: (this: WebRtcClient, ev: WebRtcClientEventMap[K]) => any, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, listener as any);
  }
}

export type WhepClientConfig = WebRtcClientConfig & {
  simulcastVideoCount?: number;
  // If provided, a container to which video elements will be added
  container?: HTMLElement
}

export class WhepClient extends WebRtcClient {
  outputVideoTracks: MediaStreamTrack[] = [];
  outputAudioTrack?: MediaStreamTrack;
  videoElements: HTMLVideoElement[] = [];
  container?: HTMLElement
  simulcastVideoCount: number;

  constructor(config: WhepClientConfig) {
    super(config);
    this.simulcastVideoCount = config.simulcastVideoCount || 1;
    this.container = config.container;
  }

  async start() {
    const client = this.client;

    for (let _ of Array(this.simulcastVideoCount)) {
      client.addTransceiver('video', { 'direction': 'recvonly' });
    }
    client.addTransceiver('audio', { 'direction': 'recvonly' });

    this.sendOffer();
  }

  async handleGotTrack(ev: RTCTrackEvent) {
    console.log("Got a track", ev);
    // Why do we have 'empty' tracks when a stream is live but non-empty when not
    if (ev.track.kind == 'video' && ev.streams.length > 0) {
      this.outputVideoTracks.push(ev.track);
    }
    if (ev.track.kind == 'audio') {
      this.outputAudioTrack = ev.track;
    }

    if (this.outputAudioTrack && this.outputVideoTracks.length > this.videoElements.length) {
      for (let i = 0; i < this.outputVideoTracks.length; i++) {
        if (this.videoElements[i]) continue;
        let stream = undefined;
        if (i == 0) {
          stream = new MediaStream([this.outputAudioTrack, this.outputVideoTracks[i]]);
        } else {
          stream = new MediaStream([this.outputVideoTracks[i]]);
        }
        if (this.container) {
          this.videoElements.push(createPlayerElement(stream, this.container));
        }
      }
    }
  }
}


export type WhipClientConfig = WebRtcClientConfig;

export class WhipClient extends WebRtcClient {
  media: MediaStream | undefined;

  constructor(config: WhipClientConfig) {
    super(config);
  }

  async requestAccess() {
    this.media = await requestAccess() || undefined;
  }

  async start(): Promise<boolean> {
    if (this.media === undefined) {
      await this.requestAccess();
      if (!this.media) {
        console.error("Could not access media devices");
        return false;
      }
    }
    const client = this.client;

    for (const track of this.media.getTracks()) {
      console.log("Adding track", track.id);
      client.addTrack(track);
    }

    await this.sendOffer();
    return true;
  }
}

export type DuplexClientConfig = WhipClientConfig & WhepClientConfig;

export class DuplexClient extends WebRtcClient {
  media: MediaStream | undefined;
  outputVideoTracks: MediaStreamTrack[] = [];
  outputAudioTrack?: MediaStreamTrack;
  videoElements: HTMLVideoElement[] = [];
  container: HTMLElement | null
  simulcastVideoCount: number;


  constructor(config: DuplexClientConfig) {
    super(config);
    this.simulcastVideoCount = config.simulcastVideoCount || 1;
    this.container = config.container || document.getElementById('container');
  }

  async requestAccess() {
    this.media = await requestAccess() || undefined;
  }

  async start() {
    if (this.media === undefined) {
      await this.requestAccess();
    }

    const client = this.client;

    for (let _ of Array(this.simulcastVideoCount)) {
      client.addTransceiver('video', { 'direction': 'recvonly' });
    }
    client.addTransceiver('audio', { 'direction': 'recvonly' });

    if (this.media) {
      for (const track of this.media.getTracks()) {
        console.log("Adding track", track.id);
        client.addTrack(track);
      }
    }

    this.sendOffer();
  }

  // This is just like WHEP I just don't want to do a mixin or whatever
  async handleGotTrack(ev: RTCTrackEvent) {
    console.log("Got a track", ev);
    // Why do we have 'empty' tracks when a stream is live but non-empty when not
    if (ev.track.kind == 'video' && ev.streams.length > 0) {
      this.outputVideoTracks.push(ev.track);
    }
    if (ev.track.kind == 'audio') {
      this.outputAudioTrack = ev.track;
    }

    if (this.outputAudioTrack && this.outputVideoTracks.length > this.videoElements.length) {
      for (let i = 0; i < this.outputVideoTracks.length; i++) {
        if (this.videoElements[i]) continue;
        let stream = undefined;
        if (i == 0) {
          stream = new MediaStream([this.outputAudioTrack, this.outputVideoTracks[i]]);
        } else {
          stream = new MediaStream([this.outputVideoTracks[i]]);
        }
        if (this.container) {
          this.videoElements.push(createPlayerElement(stream, this.container));
        }
      }
    }
  }
}

async function requestAccess() {
  if (!navigator.mediaDevices) {
    console.log("Can't request user media (insecure context?)");
    return null;
  }
  console.log("Requesting access to user media");
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    console.debug(media);

    return media;
  } catch (err) {
    console.warn("Couldn't get user media", err);
    return null;
  }
}

function createPlayerElement(stream: MediaStream, container: HTMLElement) {
  var element = document.createElement("video");
  element.controls = true;
  container.appendChild(element);
  element.muted = true;
  element.autoplay = true;
  element.srcObject = stream;
  return element;
}