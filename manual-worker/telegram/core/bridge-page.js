const PERMISSIONS_POLICY = [
  "accelerometer", "ambient-light-sensor", "autoplay", "camera", "clipboard-read", "clipboard-write",
  "display-capture", "gyroscope", "hid", "magnetometer", "microphone", "payment", "screen-wake-lock",
  "serial", "usb"
].map((name) => name + "=()").join(", ");

const PAGE_SCRIPT = `(()=>{
'use strict';
const bootstrap=__BOOTSTRAP__;
const relayBase=location.origin+'/';
const androidNonce=/^#android=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1]||'';
history.replaceState(null,'',location.pathname);
let initialized=false,closed=false,port=null,sessionToken='',createStarted=false,webSocket=null;
const pending=[];
const status=state=>{if(port&&!closed)port.postMessage({t:'status',state})};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requestOptions=(method,token,body,keepalive)=>({
method,body,keepalive:!!keepalive,mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/octet-stream'}:{})
});
const splitFrames=buffer=>{
const frames=[];const view=new DataView(buffer);let offset=0;
while(offset<buffer.byteLength){
if(buffer.byteLength-offset<8)throw new Error('truncated frame');
const size=8+view.getUint32(offset+4,false);
if(offset+size>buffer.byteLength)throw new Error('truncated frame');
frames.push(buffer.slice(offset,offset+size));offset+=size;
}
return frames;
};
function fail(){
if(closed)return;
status('failed');
if(port)port.postMessage({t:'close'});
close(true);
}
function close(notifyServer){
if(closed)return;
closed=true;
if(webSocket)try{webSocket.close()}catch(error){}
if(notifyServer&&sessionToken)fetch(relayBase+'api/v1/session',requestOptions('DELETE',sessionToken,null,true)).catch(()=>{});
if(port)port.close();
}
async function createRequest(first){
for(let attempt=0;attempt<5;attempt++){
const response=await fetch(relayBase+'api/v1/session',requestOptions('POST',bootstrap,first));
if(response.status!==503)return response;
await pause(1000);
}
throw new Error('session creation unavailable');
}
function openWebSocket(){
return new Promise((resolve,reject)=>{
const socket=new WebSocket(relayBase.replace(/^https:/,'wss:')+'api/v1/ws','tproxy-v1.'+sessionToken);
webSocket=socket;socket.binaryType='arraybuffer';
socket.onopen=()=>resolve();
socket.onmessage=event=>{
if(!(event.data instanceof ArrayBuffer)||!event.data.byteLength){fail();return}
port.postMessage({t:'traffic',up:0,down:event.data.byteLength});
port.postMessage(event.data,[event.data]);
status('connected');
};
socket.onerror=()=>reject(new Error('websocket failed'));
socket.onclose=()=>{if(!closed)fail()};
});
}
function sendUp(data){
if(closed||!webSocket||webSocket.readyState!==WebSocket.OPEN){fail();return}
try{
webSocket.send(data);
port.postMessage({t:'traffic',up:data.byteLength,down:0});
}catch(error){fail()}
}
async function createSession(first){
try{
status('connecting');
const response=await createRequest(first);
if(response.status!==200||response.headers.get('X-Carrier-Mode')!=='websocket')throw new Error('session creation rejected');
sessionToken=response.headers.get('X-Session-Token')||'';
if(!sessionToken)throw new Error('missing session token');
if(closed){fetch(relayBase+'api/v1/session',requestOptions('DELETE',sessionToken,null,true)).catch(()=>{});return}
const welcome=await response.arrayBuffer();
await openWebSocket();
if(closed){fetch(relayBase+'api/v1/session',requestOptions('DELETE',sessionToken,null,true)).catch(()=>{});return}
port.postMessage(welcome,[welcome]);
status('connected');
for(const data of pending.splice(0))sendUp(data);
}catch(error){fail()}
}
function activatePort(nextPort){
initialized=true;port=nextPort;
port.onmessage=message=>{
if(message.data instanceof ArrayBuffer){
if(!createStarted){createStarted=true;createSession(message.data)}
else if(!sessionToken||!webSocket||webSocket.readyState!==WebSocket.OPEN)pending.push(message.data);
else sendUp(message.data);
}else if(message.data&&message.data.t==='close')close(true);
};
port.start();status('connecting');
}
addEventListener('message',event=>{
if(initialized||event.source!==parent||event.data===null||typeof event.data!=='object')return;
const keys=Object.keys(event.data).sort();
if(keys.length!==2||keys[0]!=='t'||keys[1]!=='v'||event.data.t!=='tproxy-init'||event.data.v!==1||event.ports.length!==1)return;
let source;try{source=new URL(event.origin)}catch(error){return}
if(source.protocol!=='http:'||source.hostname!=='127.0.0.1'||!source.port||source.origin!==event.origin)return;
activatePort(event.ports[0]);
});
const androidBridge=globalThis.TelegramWebProxy;
if(!initialized&&androidNonce&&androidBridge&&typeof androidBridge.postMessage==='function'){
const androidPort={onmessage:null,start(){},close(){androidBridge.onmessage=null},postMessage(value){
if(value instanceof ArrayBuffer){
let frames;try{frames=splitFrames(value)}catch(error){fail();return}
for(const frame of frames)androidBridge.postMessage(frame);
}else androidBridge.postMessage(JSON.stringify(value));
}};
androidBridge.onmessage=event=>{
let data=event.data;
if(typeof data==='string'){try{data=JSON.parse(data)}catch(error){return}}
if(androidPort.onmessage)androidPort.onmessage({data});
};
activatePort(androidPort);
androidBridge.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce:androidNonce}));
}
addEventListener('pagehide',()=>close(true),{once:true});
})();`;

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function renderBridgeResponse(hostname, bootstrapToken) {
  const nonce = randomNonce();
  const script = PAGE_SCRIPT.replace("__BOOTSTRAP__", JSON.stringify(bootstrapToken));
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Connection</title>\n</head>\n<body>\n<script nonce="${nonce}">\n${script}\n</script>\n</body>\n</html>\n`;
  const csp = [
    "default-src 'none'", "base-uri 'none'", "child-src 'none'", `connect-src 'self' wss://${hostname}`,
    "font-src 'none'", "form-action 'none'", "frame-ancestors http://127.0.0.1:*", "frame-src 'none'",
    "img-src 'none'", "manifest-src 'none'", "media-src 'none'", "object-src 'none'",
    `script-src 'nonce-${nonce}'`, "style-src 'none'", "worker-src 'none'", "sandbox allow-same-origin allow-scripts"
  ].join("; ");
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "Permissions-Policy": PERMISSIONS_POLICY
    }
  });
}

export { renderBridgeResponse, PAGE_SCRIPT };
