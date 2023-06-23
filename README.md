# webrtc-client

A simple client wrapper to initiate WebRTC connections via WHIP, WHEP and the similar internal duplex protocol for Norsk.

In the case of WHIP and WHEP, this package is provided in case it might be useful, but does not aim to be a fully general solution -
there are other JS libraries supporting WHIP and WHEP, as well as non-browser alternatives. This implementation is tested
with Norsk and used for internal test pages.

In the case of the Norsk duplex protocol - which is ultimately very similar to WHIP and WHEP - this code should provide a suitable
integration point. In that case there are no real alternatives other than deriving your own implementation, or simply making separate
webrtc connections for ingest and egest.

## Usage

Create a client: 

```
let myClient = new WhepClient({url: "subscribe"});
```
or 
```
let myClient = new WhipClient({url: "publish"});
```
or
```
let myClient = new DuplexClient({url: "subscribe"});
```

Then start the client as required:

```
await myClient.start();
```

For WHEP and Duplex clients you can optionally provide a `container` element, to which an appropriate video element will be added, and also optionally set up for simulcast video:

```
new WhepClient({url: "subscribe", container: document.getElementById('container'), simulcastVideoCount: 3 });
```

Otherwise you will find the created `RTCPeerConnection` can be accessed and used as normal:
```
myClient.client.addEventListener('track', (event) => console.log(event));
```

## Alternatives

* [@eyevinn/wrtc-egress](https://www.npmjs.com/package/@eyevinn/wrtc-egress) - WHEP and WHPP egress
* [@eyevinn/webrtc-player](https://www.npmjs.com/package/@eyevinn/webrtc-player) - player supporting WHIP
* [@medooze/whip-whep-js](https://github.com/medooze/whip-whep-js) - WHIP and WHEP clients
* [Cloudflare](https://developers.cloudflare.com/stream/webrtc-beta/#supported-whip-and-whep-clients) provide sample client code