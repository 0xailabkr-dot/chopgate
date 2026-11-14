var en=Object.create;var U=Object.defineProperty;var tn=Object.getOwnPropertyDescriptor;var nn=Object.getOwnPropertyNames;var sn=Object.getPrototypeOf,on=Object.prototype.hasOwnProperty;var rn=(n,e,t)=>e in n?U(n,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):n[e]=t;var w=(n,e)=>()=>{try{return e||n((e={exports:{}}).exports,e),e.exports}catch(t){throw e=0,t}},an=(n,e)=>{for(var t in e)U(n,t,{get:e[t],enumerable:!0})},cn=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of nn(e))!on.call(n,o)&&o!==t&&U(n,o,{get:()=>e[o],enumerable:!(s=tn(e,o))||s.enumerable});return n};var ln=(n,e,t)=>(t=n!=null?en(sn(n)):{},cn(e||!n||!n.__esModule?U(t,"default",{value:n,enumerable:!0}):t,n));var c=(n,e,t)=>rn(n,typeof e!="symbol"?e+"":e,t);var pe=w(H=>{"use strict";Object.defineProperty(H,"__esModule",{value:!0});H.LocalStorage=void 0;var ge=class{async get(e){return typeof window>"u"?null:localStorage.getItem(e)}async set(e,t){typeof window>"u"||localStorage.setItem(e,t)}async remove(e){typeof window>"u"||localStorage.removeItem(e)}};H.LocalStorage=ge});var dt=w(me=>{"use strict";Object.defineProperty(me,"__esModule",{value:!0});me.encodeBase58=dn;var lt="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";function dn(n){if(n.length===0)return"";let e=0,t=0;for(;t<n.length&&n[t]===0;)e++,t++;let s=[0];for(;t<n.length;t++){let r=n[t];for(let a=0;a<s.length;++a)r+=s[a]<<8,s[a]=r%58,r=r/58|0;for(;r>0;)s.push(r%58),r=r/58|0}for(;s.length>0&&s[s.length-1]===0;)s.pop();let o="";for(let r=0;r<e;r++)o+=lt[0];for(let r=s.length-1;r>=0;--r)o+=lt[s[r]];return o}});var q=w(V=>{"use strict";Object.defineProperty(V,"__esModule",{value:!0});V.nearActionsToConnectorActions=void 0;var un=dt(),fn=n=>{try{return JSON.parse(new TextDecoder().decode(n))}catch{return n}},hn=n=>n.enum!=null?n.enum==="fullAccess":"fullAccess"in n,wn=n=>n.enum!=null?n.enum==="AccountId":"AccountId"in n,gn=n=>n.map(e=>{if("type"in e)return e;if(e.signedDelegate)throw new Error("SignedDelegate actions cannot be sent through the wallet connector; wallets sign delegates via signDelegateActions");if(e.functionCall)return{type:"FunctionCall",params:{methodName:e.functionCall.methodName,args:fn(e.functionCall.args),gas:e.functionCall.gas.toString(),deposit:e.functionCall.deposit.toString()}};if(e.deployGlobalContract)return{type:"DeployGlobalContract",params:{code:e.deployGlobalContract.code,deployMode:wn(e.deployGlobalContract.deployMode)?"AccountId":"CodeHash"}};if(e.createAccount)return{type:"CreateAccount"};if(e.useGlobalContract){let t=e.useGlobalContract.contractIdentifier;return{type:"UseGlobalContract",params:{contractIdentifier:t.AccountId!=null?{accountId:t.AccountId}:{codeHash:(0,un.encodeBase58)(t.CodeHash)}}}}if(e.deployContract)return{type:"DeployContract",params:{code:e.deployContract.code}};if(e.deleteAccount)return{type:"DeleteAccount",params:{beneficiaryId:e.deleteAccount.beneficiaryId}};if(e.deleteKey)return{type:"DeleteKey",params:{publicKey:e.deleteKey.publicKey.toString()}};if(e.transfer)return{type:"Transfer",params:{deposit:e.transfer.deposit.toString()}};if(e.stake)return{type:"Stake",params:{stake:e.stake.stake.toString(),publicKey:e.stake.publicKey.toString()}};if(e.addKey){let{permission:t}=e.addKey.accessKey,s;if(t.functionCall)s={receiverId:t.functionCall.receiverId,allowance:t.functionCall.allowance?.toString(),methodNames:t.functionCall.methodNames};else if(hn(t))s="FullAccess";else throw new Error("Unsupported access-key permission on AddKey: only functionCall and fullAccess can be sent through the wallet connector (pass a ConnectorAction otherwise)");return{type:"AddKey",params:{publicKey:e.addKey.publicKey.toString(),accessKey:{nonce:Number(e.addKey.accessKey.nonce),permission:s}}}}throw new Error("Unsupported action type")});V.nearActionsToConnectorActions=gn});var F=w(W=>{"use strict";Object.defineProperty(W,"__esModule",{value:!0});W.isGasKeyAction=void 0;W.assertGasKeyActionsSupported=mn;var pn=n=>n.type==="TransferToGasKey"||n.type==="WithdrawFromGasKey"||n.type==="AddKey"&&n.params.gasKeyInfo!=null;W.isGasKeyAction=pn;function mn(n,e,t){if(n?.gasKeys)return;let s=e.filter(W.isGasKeyAction).map(o=>o.type);if(s.length!==0)throw new Error(`${t} does not advertise gas-key support (manifest features.gasKeys), so ${[...new Set(s)].join(", ")} cannot be sent through it; a wallet that does not know gasKeyInfo could add a plain key instead. Sign locally with a full-access key, or use a wallet whose manifest sets features.gasKeys.`)}});var Z=w(Y=>{"use strict";Object.defineProperty(Y,"__esModule",{value:!0});Y.uuid4=void 0;var yn=()=>typeof window<"u"&&typeof window.crypto<"u"&&typeof window.crypto.randomUUID=="function"?window.crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(n){let e=Math.random()*16|0;return(n==="x"?e:e&3|8).toString(16)});Y.uuid4=yn});var ve=w(X=>{"use strict";Object.defineProperty(X,"__esModule",{value:!0});X.ParentFrameWallet=void 0;var ye=q(),be=F(),bn=Z(),xe=class{constructor(e,t){c(this,"connector");c(this,"manifest");this.connector=e,this.manifest=t}callParentFrame(e,t){let s=(0,bn.uuid4)();return window.parent.postMessage({type:"near-wallet-injected-request",id:s,method:e,params:t},"*"),new Promise((o,r)=>{let a=i=>{i.data.type==="near-wallet-injected-response"&&i.data.id===s&&(window.removeEventListener("message",a),i.data.success?o(i.data.result):r(i.data.error))};window.addEventListener("message",a)})}async signIn(e){let t=await this.callParentFrame("near:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey});return Array.isArray(t)?t:[t]}async signInAndSignMessage(e){let t=await this.callParentFrame("near:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams});return Array.isArray(t)?t:[t]}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.callParentFrame("near:signOut",t)}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.callParentFrame("near:getAccounts",t)}async signAndSendTransaction(e){let t=(0,ye.nearActionsToConnectorActions)(e.actions);(0,be.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let s={...e,actions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransaction",s)}async signAndSendTransactions(e){let t=e.transactions.map(o=>({actions:(0,ye.nearActionsToConnectorActions)(o.actions),receiverId:o.receiverId}));(0,be.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(o=>o.actions),this.manifest.name);let s={...e,transactions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransactions",s)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.callParentFrame("near:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(s=>({...s,actions:(0,ye.nearActionsToConnectorActions)(s.actions)})),network:e.network||this.connector.network};return(0,be.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(s=>s.actions),this.manifest.name),this.callParentFrame("near:signDelegateActions",t)}};X.ParentFrameWallet=xe});var Ae=w(J=>{"use strict";Object.defineProperty(J,"__esModule",{value:!0});J.parseUrl=void 0;var xn=n=>{try{return new URL(n)}catch{return null}};J.parseUrl=xn});var ut=w(Q=>{"use strict";Object.defineProperty(Q,"__esModule",{value:!0});Q.copyText=void 0;var vn=async n=>{try{await navigator.clipboard.writeText(n);return}catch{}let e=document.createElement("textarea");e.value=n,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select();try{if(!document.execCommand("copy"))throw new Error("Copy failed")}finally{e.remove()}};Q.copyText=vn});var ht=w(P=>{"use strict";Object.defineProperty(P,"__esModule",{value:!0});P.openExternalLink=P.openTelegramLink=P.isTelegramMiniApp=void 0;var ke=()=>{let n=window?.Telegram?.WebApp;return!n||!n.platform||n.platform==="unknown"?null:n},An=()=>{try{return location.hash.includes("tgWebAppData")?!0:!!sessionStorage.getItem("__telegram__initParams")}catch{return!1}},kn=()=>typeof window>"u"?!1:!!ke()||!!window.TelegramWebviewProxy||An();P.isTelegramMiniApp=kn;var ft=(n,e)=>{let t=window.TelegramWebviewProxy;if(t?.postEvent)return t.postEvent(n,JSON.stringify(e));let s=window.external;if(s&&"notify"in s)return s.notify(JSON.stringify({eventType:n,eventData:e}));window.parent!==window&&window.parent.postMessage(JSON.stringify({eventType:n,eventData:e}),"https://web.telegram.org")},Sn=n=>{let e=ke();if(e)return e.openTelegramLink(n.toString());ft("web_app_open_tg_link",{path_full:n.pathname+n.search})};P.openTelegramLink=Sn;var Cn=n=>{let e=ke();if(e)return e.openLink(n.toString());ft("web_app_open_link",{url:n.toString()})};P.openExternalLink=Cn});var Ce=w(ee=>{"use strict";Object.defineProperty(ee,"__esModule",{value:!0});ee.EventEmitter=void 0;var Se=class{constructor(){c(this,"events",{})}on(e,t){this.events[e]||(this.events[e]=[]),this.events[e].push(t)}emit(e,t){this.events[e]?.forEach(s=>s(t))}off(e,t){this.events[e]=this.events[e]?.filter(s=>s!==t)}once(e,t){let s=o=>{t(o),this.off(e,s)};this.on(e,s)}removeAllListeners(e){e?delete this.events[e]:this.events={}}};ee.EventEmitter=Se});var ne=w(te=>{"use strict";Object.defineProperty(te,"__esModule",{value:!0});te.escapeHtml=wt;te.html=_n;function wt(n){return n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var _e=Symbol("htmlTag");function _n(n,...e){let t=n[0];for(let s=0;s<e.length;s++){for(let o of Array.isArray(e[s])?e[s]:[e[s]]){let r=o?.[_e]?o[_e]:wt(String(o??""));t+=r}t+=n[s+1]}return Object.freeze({[_e]:t,get html(){return t}})}});var gt=w(se=>{"use strict";Object.defineProperty(se,"__esModule",{value:!0});se.css=void 0;var Pn=n=>`
${n} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  -ms-overflow-style: none; 
  scrollbar-width: none; 
  color: #fff;
}

${n} *::-webkit-scrollbar { 
  display: none;
}

${n} p,
${n} h1,
${n} h2,
${n} h3,
${n} h4,
${n} h5,
${n} h6 {
  margin: 0;
}

${n} .modal-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 100000000;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    transition: opacity 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${n} .modal-container {
    justify-content: flex-end;
  }
}

${n} .modal-content {
  display: flex;
  flex-direction: column;
  align-items: center;

  max-width: 420px;
  max-height: 615px;
  width: 100%;
  border-radius: 24px;
  background: #0d0d0d;
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  transition: transform 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${n} .modal-content {
    max-width: 100%;
    width: 100%;
    max-height: 80%;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border: none;
    border-top: 1.5px solid rgba(255, 255, 255, 0.1);
  }
}


${n} .modal-header {
  display: flex;
  padding: 16px;
  gap: 16px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  position: relative;
}

${n} .modal-header button {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 32px;
  height: 32px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.2s ease-in-out;
  border: none;
  background: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

${n} .modal-header button:hover {
  background: rgba(255, 255, 255, 0.04);
}
  
${n} .modal-header p {
  color: #fff;
  text-align: center;
  font-size: 24px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  margin: 0;
}


${n} .modal-body {
  display: flex;
  padding: 16px;
  flex-direction: column;
  align-items: flex-start;
  text-align: center;
  gap: 8px;
  overflow: auto;

  border-radius: 24px;
  background: rgba(255, 255, 255, 0.08);
  width: 100%;
  flex: 1;
}

${n} .modal-body textarea {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #0d0d0d;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  outline: none;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  font-family: monospace;
  font-size: 12px;
}

${n} .modal-body button {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  color: #000;
  border: none;
  cursor: pointer;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  margin-top: 16px;
}

${n} .footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 16px 24px;
  color: #fff;
  gap: 12px;
}

${n} .modal-body p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: normal;
  letter-spacing: -0.8px;
}

${n} .footer img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

${n} .get-wallet-link {
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  margin-left: auto;
  text-decoration: none;
  transition: color 0.2s ease-in-out;
  cursor: pointer;
}
  
${n} .get-wallet-link:hover {
  color: rgba(255, 255, 255, 1);
}


${n} .connect-item {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 12px;
  align-self: stretch;
  cursor: pointer;

  transition: background 0.2s ease-in-out;
  border-radius: 24px;
}

${n} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
  flex-shrink: 0;
}

${n} .connect-item-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  flex: 1;
  margin-top: -2px;
}

${n} .connect-item-info .wallet-address {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: normal;
}

${n} .connect-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

${n} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
}

${n} .connect-item p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 18px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  letter-spacing: -0.36px;
  margin: 0;
}
`;se.css=Pn});var Ee=w(oe=>{"use strict";Object.defineProperty(oe,"__esModule",{value:!0});oe.Popup=void 0;var En=gt(),In=ne(),pt=`n${Math.random().toString(36).substring(2,15)}`;if(typeof document<"u"){let n=document.createElement("style");n.textContent=(0,En.css)(`.${pt}`),document.head.append(n)}var Pe=class{constructor(e){c(this,"delegate");c(this,"isClosed",!1);c(this,"root",document.createElement("div"));c(this,"state",{});c(this,"disposables",[]);this.delegate=e}get dom(){return(0,In.html)``}addListener(e,t,s){let o=typeof e=="string"?this.root.querySelector(e):e;o&&(o.addEventListener(t,s),this.disposables.push(()=>o.removeEventListener(t,s)))}handlers(){this.disposables.forEach(o=>o()),this.disposables=[];let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.onclick=o=>o.stopPropagation(),e.onclick=()=>{this.delegate.onReject(),this.destroy()};let s=o=>{o.key==="Escape"&&(this.delegate.onReject(),this.destroy())};document.addEventListener("keydown",s),this.disposables.push(()=>document.removeEventListener("keydown",s))}update(e){this.state={...this.state,...e},this.root.innerHTML=this.dom.html,this.handlers()}create({show:e=!0}){this.root.className=`${pt} hot-connector-popup`,this.root.style.display="none",this.root.innerHTML=this.dom.html,document.body.append(this.root),this.handlers();let t=this.root.querySelector(".modal-container"),s=this.root.querySelector(".modal-content");s.style.transform="translateY(50px)",t.style.opacity="0",e&&setTimeout(()=>this.show(),10)}show(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",this.root.style.display="block",setTimeout(()=>{t.style.transform="translateY(0)",e.style.opacity="1"},100)}hide(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",setTimeout(()=>{this.root.style.display="none"},200)}destroy(){this.isClosed||(this.isClosed=!0,this.disposables.forEach(e=>e()),this.disposables=[],this.hide(),setTimeout(()=>{this.root.remove()},200))}};oe.Popup=Pe});var mt=w(re=>{"use strict";Object.defineProperty(re,"__esModule",{value:!0});re.IframeWalletPopup=void 0;var Ie=ne(),Mn=Ee(),Me=class extends Mn.Popup{constructor(t){super(t);c(this,"delegate");this.delegate=t}handlers(){super.handlers(),this.addListener("button","click",()=>this.delegate.onApprove())}create(){super.create({show:!1}),this.root.querySelector(".modal-body").appendChild(this.delegate.iframe),this.delegate.iframe.style.width="100%",this.delegate.iframe.style.height="720px",this.delegate.iframe.style.border="none"}get footer(){if(!this.delegate.footer)return"";let{icon:t,heading:s}=this.delegate.footer;return(0,Ie.html)`
      <div class="footer">
        ${t?(0,Ie.html)`<img src="${t}" alt="${s}" />`:""}
        <p>${s}</p>
      </div>
    `}get dom(){return(0,Ie.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-body" style="padding: 0; overflow: auto;"></div>
        ${this.footer}
      </div>
    </div>`}};re.IframeWalletPopup=Me});var yt=w(ae=>{"use strict";Object.defineProperty(ae,"__esModule",{value:!0});ae.NEAR_CONNECT_VERSION=void 0;ae.NEAR_CONNECT_VERSION="0.12.0"});var bt=w($e=>{"use strict";Object.defineProperty($e,"__esModule",{value:!0});var $n=yt();async function Nn(n){let e=await n.executor.getAllStorage(),t=n.executor.connector.providers,s=n.executor.manifest,o=n.id,r=n.code.replaceAll(".localStorage",".sandboxedLocalStorage").replaceAll("window.top","window.selector").replaceAll("window.open","window.selector.open"),a=n.cspNonce?` nonce="${n.cspNonce.replace(/[^A-Za-z0-9+/=]/g,"")}"`:"";return`
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body>
      <div id="root"></div>

      <style>
        :root {
          --background-color: rgb(40, 40, 40);
          --text-color: rgb(255, 255, 255);
          --border-color: rgb(209, 209, 209);
        }

        * {
          font-family: system-ui, Avenir, Helvetica, Arial, sans-serif
        }

        body, html {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          background-color: var(--background-color);
          color: var(--text-color);
        }

        #root {
          display: none;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
          background: radial-gradient(circle at center, #2c2c2c 0%, #1a1a1a 100%);
          text-align: center;
        }

        #root * {
          box-sizing: border-box;
          font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
          line-height: 1.5;
          color-scheme: light dark;
          color: rgb(255, 255, 255);
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
        }

        .prompt-container img {
          width: 100px;
          height: 100px;
          object-fit: cover;
          border-radius: 12px;
        }

        .prompt-container h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
          margin-top: 16px;
        }

        .prompt-container p {
          margin: 0;
          font-size: 16px;
          font-weight: 500;
          color: rgb(209, 209, 209);
        }

        .prompt-container button {
          background-color: #131313;
          border: none;
          border-radius: 12px;
          padding: 12px 24px;
          cursor: pointer;
          transition: border-color 0.25s;
          color: #fff;
          outline: none;
          font-size: 14px;
          font-weight: 500;
          font-family: inherit;
          margin-top: 16px;
        }
      </style>


      <script${a}>
      window.sandboxedLocalStorage = (() => {
        let storage = ${JSON.stringify(e)}

        return {
          setItem: function(key, value) {
            window.selector.storage.set(key, value)
            storage[key] = value || '';
          },
          getItem: function(key) {
            return key in storage ? storage[key] : null;
          },
          removeItem: function(key) {
            window.selector.storage.remove(key)
            delete storage[key];
          },
          get length() {
            return Object.keys(storage).length;
          },
          key: function(i) {
            const keys = Object.keys(storage);
            return keys[i] || null;
          },
        };
      })();

      const showPrompt = async (args) => {
        const root = document.getElementById("root");   
        root.style.display = "flex";
        root.innerHTML = \`
          <div class="prompt-container">
            <img src="${s.icon}" />
            <h1>${s.name}</h1>
            <p>\${args.title}</p>
            <button>\${args.button}</button>
          </div>
        \`;

        return new Promise((resolve) => {
          root.querySelector("button")?.addEventListener("click", () => {
            root.innerHTML = "";
            resolve(true);
          });
        });
      }

      class ProxyWindow {
        constructor(url, features) {
          this.closed = false;
          this.windowIdPromise = window.selector.call("open", { url, features });

          window.addEventListener("message", async (event) => {            
            if (event.data.origin !== "${o}") return;
            if (!event.data.method?.startsWith("proxy-window:")) return;
            const method = event.data.method.replace("proxy-window:", "");
            if (method === "closed" && event.data.windowId === await this.id()) this.closed = true;
          });
        } 

        async id() {
          return await this.windowIdPromise;
        }

        async focus() {
          await window.selector.call("panel.focus", { windowId: await this.id() });
        }

        async postMessage(data) {
          window.selector.call("panel.postMessage", { windowId: await this.id(), data });
        }

        async close() {
          await window.selector.call("panel.close", { windowId: await this.id() });
        }
      }

      window.selector = {
        wallet: null,
        location: "${window.location.href}",
        nearConnectVersion: "${$n.NEAR_CONNECT_VERSION}",
        
        outerHeight: ${window.outerHeight},
        screenY: ${window.screenY},
        outerWidth: ${window.outerWidth},
        screenX: ${window.screenX},

        providers: {
          mainnet: ${JSON.stringify(t.mainnet)},
          testnet: ${JSON.stringify(t.testnet)},
        },

        uuid() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        },

        walletConnect: {
          connect(params) {
            return window.selector.call("walletConnect.connect", params);
          },
          disconnect(params) {
            return window.selector.call("walletConnect.disconnect", params);
          },
          request(params) {
            return window.selector.call("walletConnect.request", params);
          },
          getProjectId() {
            return window.selector.call("walletConnect.getProjectId", {});
          },
          getSession() {
            return window.selector.call("walletConnect.getSession", {});
          },
        },
      
        async ready(wallet) {
          wallet.manifest = ${JSON.stringify(s)};
          window.parent.postMessage({ method: "wallet-ready", origin: "${o}" }, "*");
          window.selector.wallet = wallet;
        },

        async call(method, params) {
          const id = window.selector.uuid();
          window.parent.postMessage({ method, params, id, origin: "${o}" }, "*");

          return new Promise((resolve, reject) => {
            const handler = (event) => {
              if (event.data.id !== id || event.data.origin !== "${o}") return;
              window.removeEventListener("message", handler);

              if (event.data.status === "failed") reject(event.data.result);
              else resolve(event.data.result);
            };

            window.addEventListener("message", handler);
          });
        },

        panelClosed(windowId) {
          window.parent.postMessage({ 
            method: "panel.closed", 
            origin: "${o}", 
            result: { windowId } 
          }, "*");
        },

        open(url, _, params) {
          return new ProxyWindow(url, params)
        },

        external(entity, key, ...args) {
          return window.selector.call("external", { entity, key, args: args || [] });
        },

        openNativeApp(url) {
          return window.selector.call("open.nativeApp", { url });
        },

        ui: {
          async whenApprove(options) {
            window.selector.ui.showIframe();
            await showPrompt(options);
            window.selector.ui.hideIframe();
          },

          async showIframe() {
            return await window.selector.call("ui.showIframe");
          },

          async hideIframe() {
            return await window.selector.call("ui.hideIframe");
          },
        },

        storage: {
          async set(key, value) {
            await window.selector.call("storage.set", { key, value });
          },
      
          async get(key) {
            return await window.selector.call("storage.get", { key });
          },
      
          async remove(key) {
            await window.selector.call("storage.remove", { key });
          },

          async keys() {
            return await window.selector.call("storage.keys", {});
          },
        },
      };

      // Clipboard API often rejects inside the sandbox (Android WebView), copy through the dApp page then.
      // Plain assignment to navigator.clipboard is a no-op (getter on the prototype), so redefine the method
      const clipboard = navigator.clipboard || {};
      const nativeWriteText = clipboard.writeText ? clipboard.writeText.bind(clipboard) : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          try {
            if (nativeWriteText) return await nativeWriteText(text);
          } catch {}
          await window.selector.call("clipboard.writeText", { text });
        },
      });
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

      window.addEventListener("message", async (event) => {
        if (event.data.origin !== "${o}") return;
        if (!event.data.method?.startsWith("wallet:")) return;
      
        const wallet = window.selector.wallet;
        const method = event.data.method.replace("wallet:", "");
        const payload = { id: event.data.id, origin: "${o}", method };
      
        if (wallet == null || typeof wallet[method] !== "function") {
          const data = { ...payload, status: "failed", result: "Method not found" };
          window.parent.postMessage(data, "*");
          return;
        }
        
        try {
          const result = await wallet[method](event.data.params);
          window.parent.postMessage({ ...payload, status: "success", result }, "*");
        } catch (error) {
          const data = { ...payload, status: "failed", result: error };
          window.parent.postMessage(data, "*");
        }
      });
      <\/script>

      <script type="module"${a}>${r}<\/script>
    </body>
  </html>
    `}$e.default=Nn});var xt=w(D=>{"use strict";var Tn=D&&D.__importDefault||function(n){return n&&n.__esModule?n:{default:n}};Object.defineProperty(D,"__esModule",{value:!0});var On=Ce(),Wn=Z(),jn=mt(),Ln=Tn(bt()),Ne=class{constructor(e,t,s,o){c(this,"executor");c(this,"origin");c(this,"disposed",!1);c(this,"iframe",document.createElement("iframe"));c(this,"events",new On.EventEmitter);c(this,"popup");c(this,"handler");c(this,"readyPromiseResolve");c(this,"readyPromise",new Promise(e=>{this.readyPromiseResolve=e}));this.executor=e,this.origin=(0,Wn.uuid4)(),this.handler=a=>{a.data.origin===this.origin&&(a.data.method==="wallet-ready"&&this.readyPromiseResolve(),s(this,a))},window.addEventListener("message",this.handler);let r=[];this.executor.checkPermissions("usb")&&r.push("usb *;"),this.executor.checkPermissions("hid")&&r.push("hid *;"),this.executor.checkPermissions("clipboardRead")&&r.push("clipboard-read;"),this.executor.checkPermissions("clipboardWrite")&&r.push("clipboard-write;"),this.executor.checkPermissions("bluetooth")&&r.push("bluetooth *;"),this.iframe.allow=r.join(" "),this.iframe.setAttribute("sandbox","allow-scripts"),(0,Ln.default)({id:this.origin,executor:this.executor,code:t,cspNonce:o}).then(a=>{this.executor.connector.logger?.log("Iframe code injected"),this.iframe.srcdoc=a}),this.popup=new jn.IframeWalletPopup({footer:this.executor.connector.footerBranding,iframe:this.iframe,onApprove:()=>{},onReject:()=>{this.disposed=!0,window.removeEventListener("message",this.handler),this.events.emit("close",{}),this.popup.destroy()}}),this.popup.create()}on(e,t){this.events.on(e,t)}show(){this.popup.show()}hide(){this.popup.hide()}postMessage(e){if(this.disposed)return;let t=this.iframe.contentWindow;if(!t)throw new Error(`Iframe not loaded for ${e?.method??"unknown method"}`);t.postMessage({...e,origin:this.origin},"*")}dispose(){this.disposed=!0,window.removeEventListener("message",this.handler),this.popup.destroy()}};D.default=Ne});var vt=w(B=>{"use strict";var Kn=B&&B.__importDefault||function(n){return n&&n.__esModule?n:{default:n}};Object.defineProperty(B,"__esModule",{value:!0});var I=Ae(),Oe=Z(),qn=ut(),Te=ht(),Fn=Kn(xt()),Dn=(0,Oe.uuid4)(),We=class{constructor(e,t){c(this,"connector");c(this,"manifest");c(this,"activePanels",{});c(this,"storageSpace");c(this,"_onMessage",async(e,t)=>{let s=r=>{e.postMessage({...t.data,status:"success",result:r})},o=r=>{e.postMessage({...t.data,status:"failed",result:r})};if(t.data.method==="ui.showIframe"){e.show(),s(null);return}if(t.data.method==="ui.hideIframe"){e.hide(),s(null);return}if(t.data.method==="storage.set"){this.assertPermissions(e,"storage",t),localStorage.setItem(`${this.storageSpace}:${t.data.params.key}`,t.data.params.value),s(null);return}if(t.data.method==="storage.get"){this.assertPermissions(e,"storage",t);let r=localStorage.getItem(`${this.storageSpace}:${t.data.params.key}`);s(r);return}if(t.data.method==="storage.keys"){this.assertPermissions(e,"storage",t);let r=Object.keys(localStorage).filter(a=>a.startsWith(`${this.storageSpace}:`));s(r);return}if(t.data.method==="storage.remove"){this.assertPermissions(e,"storage",t),localStorage.removeItem(`${this.storageSpace}:${t.data.params.key}`),s(null);return}if(t.data.method==="panel.focus"){let r=this.activePanels[t.data.params.windowId];r&&r.focus(),s(null);return}if(t.data.method==="panel.postMessage"){let r=this.activePanels[t.data.params.windowId];r&&r.postMessage(t.data.params.data,"*"),s(null);return}if(t.data.method==="panel.close"){let r=this.activePanels[t.data.params.windowId];r&&r.close(),delete this.activePanels[t.data.params.windowId],s(null);return}if(t.data.method==="walletConnect.connect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).connect(t.data.params);a.approval(),s({uri:a.uri})}catch(r){o(r)}return}if(t.data.method==="walletConnect.getProjectId"){if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");this.assertPermissions(e,"walletConnect",t);let r=await this.connector.walletConnect;s(r.core.projectId);return}if(t.data.method==="walletConnect.disconnect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).disconnect(t.data.params);s(a)}catch(r){o(r)}return}if(t.data.method==="walletConnect.getSession"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let r=await this.connector.walletConnect,a=r.session.keys[r.session.keys.length-1],i=a?r.session.get(a):null;s(i?{topic:i.topic,namespaces:i.namespaces}:null)}catch(r){o(r)}return}if(t.data.method==="walletConnect.request"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).request(t.data.params);s(a)}catch(r){o(r)}return}if(t.data.method==="clipboard.writeText"){this.assertPermissions(e,"clipboardWrite",t);try{await(0,qn.copyText)(t.data.params.text),s(null)}catch(r){o(r)}return}if(t.data.method==="external"){this.assertPermissions(e,"external",t);try{let{entity:r,key:a,args:i}=t.data.params,d=r.split(".").reduce((f,h)=>f[h],window);r==="nightly.near"&&a==="signTransaction"&&(i[0].encode=()=>i[0]);let u=typeof d[a]=="function"?await d[a](...i||[]):d[a];s(u)}catch(r){o(r)}return}if(t.data.method==="open"){this.assertPermissions(e,"allowsOpen",t);let r=(0,I.parseUrl)(t.data.params.url);if(r&&r.protocol==="https:"&&(0,Te.isTelegramMiniApp)()){r.hostname==="t.me"?(0,Te.openTelegramLink)(r):(0,Te.openExternalLink)(r),s(null);return}let a=window.open(t.data.params.url,"_blank",t.data.params.features),i=a?(0,Oe.uuid4)():null,d=u=>{let f=(0,I.parseUrl)(t.data.params.url);f&&f.origin===u.origin&&e.postMessage(u.data)};if(s(i),window.addEventListener("message",d),a&&i){this.activePanels[i]=a;let u=setInterval(()=>{if(!a?.closed)return;window.removeEventListener("message",d);let f={method:"proxy-window:closed",windowId:i};delete this.activePanels[i],clearInterval(u);try{e.postMessage(f)}catch{}},500)}return}if(t.data.method==="open.nativeApp"){this.assertPermissions(e,"allowsOpen",t);let r=(0,I.parseUrl)(t.data.params.url);if(!r||["https","http","javascript:","file:","data:","blob:","about:"].includes(r.protocol))throw o("Invalid URL"),new Error("[open.nativeApp] Invalid URL");let i=document.createElement("iframe");i.src=t.data.params.url,i.style.display="none",document.body.appendChild(i),e.postMessage({...t.data,status:"success",result:null});return}});c(this,"actualCode",null);this.connector=e,this.manifest=t,this.storageSpace=t.id}checkPermissions(e,t){if(e==="walletConnect")return!!this.manifest.permissions.walletConnect;if(e==="external"){let s=this.manifest.permissions.external;return!s||!t?.entity?!1:s.includes(t.entity)}if(e==="allowsOpen"){let s=(0,I.parseUrl)(t?.url||""),o=this.manifest.permissions.allowsOpen;return!s||!o||!Array.isArray(o)||o.length===0?!1:o.some(a=>{let i=(0,I.parseUrl)(a);return!(!i||s.protocol!==i.protocol||i.hostname&&s.hostname!==i.hostname||i.pathname&&i.pathname!=="/"&&s.pathname!==i.pathname)})}return this.manifest.permissions[e]}assertPermissions(e,t,s){if(!this.checkPermissions(t,s.data.params))throw e.postMessage({...s.data,status:"failed",result:"Permission denied"}),new Error("Permission denied")}async checkNewVersion(e,t){if(this.actualCode)return this.connector.logger?.log("New version of code already checked"),this.actualCode;let s=(0,I.parseUrl)(e.manifest.executor);if(s||(s=(0,I.parseUrl)(location.origin+e.manifest.executor)),!s)throw new Error("Invalid executor URL");s.searchParams.set("nonce",Dn);let o=await fetch(s.toString()).then(r=>{if(!r.ok)throw new Error(`Failed to load executor: ${r.status}`);return r.text()});return this.connector.logger?.log("New version of code fetched"),this.actualCode=o,o===t?(this.connector.logger?.log("New version of code is the same as the current version"),this.actualCode):(await this.connector.db.setItem(`${this.manifest.id}:${this.manifest.version}`,o).then(()=>this.connector.logger?.log("New version of code saved to cache")).catch(r=>this.connector.logger?.log("Failed to cache new version of code",r)),o)}async loadCode(){let e=await this.connector.db.getItem(`${this.manifest.id}:${this.manifest.version}`).catch(()=>null);this.connector.logger?.log("Code loaded from cache",e!==null);let t=this.checkNewVersion(this,e);return e||await t}async call(e,t){this.connector.logger?.log("Add to queue",e,t),this.connector.logger?.log("Calling method",e,t);let s=await this.loadCode();this.connector.logger?.log("Code loaded, preparing");let o=new Fn.default(this,s,this._onMessage,this.connector.cspNonce);this.connector.logger?.log("Code loaded, iframe initialized"),await o.readyPromise,this.connector.logger?.log("Iframe ready");let r=(0,Oe.uuid4)();return new Promise((a,i)=>{try{let d=u=>{u.data.id!==r||u.data.origin!==o.origin||(o.dispose(),window.removeEventListener("message",d),this.connector.logger?.log("postMessage",{result:u.data,request:{method:e,params:t}}),u.data.status==="failed"?i(u.data.result):a(u.data.result))};window.addEventListener("message",d),o.postMessage({method:e,params:t,id:r}),o.on("close",()=>i(new Error("Wallet closed")))}catch(d){this.connector.logger?.log("Iframe error",d),i(d)}})}async getAllStorage(){let e=Object.keys(localStorage).filter(s=>s.startsWith(`${this.storageSpace}:`)),t={};for(let s of e)t[s.replace(`${this.storageSpace}:`,"")]=localStorage.getItem(s);return t}async clearStorage(){let e=Object.keys(localStorage).filter(t=>t.startsWith(`${this.storageSpace}:`));for(let t of e)localStorage.removeItem(t)}};B.default=We});var Ke=w(M=>{"use strict";var Bn=M&&M.__importDefault||function(n){return n&&n.__esModule?n:{default:n}};Object.defineProperty(M,"__esModule",{value:!0});M.SandboxWallet=void 0;var je=q(),Le=F(),Rn=Bn(vt()),ie=class{constructor(e,t){c(this,"connector");c(this,"manifest");c(this,"executor");this.connector=e,this.manifest=t,this.executor=new Rn.default(e,t)}async signIn(e){return this.executor.call("wallet:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey})}async signInAndSignMessage(e){return this.executor.call("wallet:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.executor.call("wallet:signOut",t),await this.executor.clearStorage()}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.executor.call("wallet:getAccounts",t)}async signAndSendTransaction(e){let t=(0,je.nearActionsToConnectorActions)(e.actions);(0,Le.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let s={...e,actions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransaction",s)}async signAndSendTransactions(e){let t=e.transactions.map(o=>({actions:(0,je.nearActionsToConnectorActions)(o.actions),receiverId:o.receiverId}));(0,Le.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(o=>o.actions),this.manifest.name);let s={...e,transactions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransactions",s)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.executor.call("wallet:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(s=>({...s,actions:(0,je.nearActionsToConnectorActions)(s.actions)})),network:e.network??this.connector.network};return(0,Le.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(s=>s.actions),this.manifest.name),this.executor.call("wallet:signDelegateActions",t)}};M.SandboxWallet=ie;M.default=ie});var Be=w(ce=>{"use strict";Object.defineProperty(ce,"__esModule",{value:!0});ce.InjectedWallet=void 0;var qe=q(),Fe=F(),De=class{constructor(e,t){c(this,"connector");c(this,"wallet");this.connector=e,this.wallet=t}get manifest(){return this.wallet.manifest}async signIn({addFunctionCallKey:e,network:t}){return this.wallet.signIn({network:t??this.connector.network,addFunctionCallKey:e})}async signInAndSignMessage(e){return this.wallet.signInAndSignMessage({network:e?.network??this.connector.network,addFunctionCallKey:e.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){await this.wallet.signOut({network:e?.network??this.connector.network})}async getAccounts(e){return this.wallet.getAccounts({network:e?.network??this.connector.network})}async signAndSendTransaction(e){let t=(0,qe.nearActionsToConnectorActions)(e.actions);(0,Fe.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let s=e.network??this.connector.network,o=await this.wallet.signAndSendTransaction({...e,actions:t,network:s});if(!o)throw new Error("No result from wallet");return Array.isArray(o.transactions)?o.transactions[0]:o}async signAndSendTransactions(e){let t=e.network??this.connector.network,s=e.transactions.map(r=>({actions:(0,qe.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,Fe.assertGasKeyActionsSupported)(this.manifest.features,s.flatMap(r=>r.actions),this.manifest.name);let o=await this.wallet.signAndSendTransactions({...e,transactions:s,network:t});if(!o)throw new Error("No result from wallet");return Array.isArray(o.transactions)?o.transactions:o}async signMessage(e){return this.wallet.signMessage({...e,network:e.network??this.connector.network})}async signDelegateActions(e){let t=e.delegateActions.map(s=>({...s,actions:(0,qe.nearActionsToConnectorActions)(s.actions)}));return(0,Fe.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(s=>s.actions),this.manifest.name),this.wallet.signDelegateActions({...e,delegateActions:t,network:e.network??this.connector.network})}};ce.InjectedWallet=De});var At=w(le=>{"use strict";Object.defineProperty(le,"__esModule",{value:!0});le.NearWalletsPopup=void 0;var j=ne(),Gn=Ae(),zn=Ee(),Un={id:"custom-wallet",name:"Custom Wallet",icon:"https://www.mynearwallet.com/images/webclip.png",description:"Custom wallet for NEAR.",website:"",version:"1.0.0",executor:"your-executor-url.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0},permissions:{storage:!0,allowsOpen:[]}},Re=class extends zn.Popup{constructor(t){super(t);c(this,"delegate");this.delegate=t,this.update({wallets:t.wallets,showSettings:!1})}handlers(){super.handlers(),this.addListener(".settings-button","click",()=>this.update({showSettings:!0})),this.addListener(".back-button","click",()=>this.update({showSettings:!1})),this.root.querySelectorAll(".connect-item").forEach(t=>{t instanceof HTMLDivElement&&this.addListener(t,"click",()=>this.delegate.onSelect(t.dataset.type))}),this.root.querySelectorAll(".remove-wallet-button").forEach(t=>{t instanceof SVGSVGElement&&this.addListener(t,"click",async s=>{s.stopPropagation(),await this.delegate.onRemoveDebugManifest(t.dataset.type);let o=this.state.wallets.filter(r=>r.id!==t.dataset.type);this.update({wallets:o})})}),this.addListener(".add-debug-manifest-button","click",async()=>{try{let t=this.root.querySelector("#debug-manifest-input")?.value??"",s=await this.delegate.onAddDebugManifest(t);this.update({showSettings:!1,wallets:[s,...this.state.wallets]})}catch(t){alert(`Something went wrong: ${t}`)}})}create(){super.create({show:!0})}walletDom(t){let s=(0,j.html)`
      <svg
        class="remove-wallet-button"
        data-type="${t.id}"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style="margin-right: 4px;"
      >
        <path d="M18 6L6 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 6L18 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;return(0,j.html)`
      <div class="connect-item" data-type="${t.id}">
        <img style="background: #333" src="${t.icon}" alt="${t.name}" />
        <div class="connect-item-info">
          <span>${t.name}</span>
          <span class="wallet-address">${(0,Gn.parseUrl)(t.website)?.hostname}</span>
        </div>
        ${t.debug?s:""}
      </div>
    `}get footer(){if(!this.delegate.footer)return"";let{icon:t,heading:s,link:o,linkText:r}=this.delegate.footer;return(0,j.html)`
      <div class="footer">
        ${t?(0,j.html)`<img src="${t}" alt="${s}" />`:""}
        <p>${s}</p>
        <a class="get-wallet-link" href="${o}" target="_blank">${r}</a>
      </div>
    `}get dom(){return this.state.showSettings?(0,j.html)`
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              <button class="back-button" style="left: 16px; right: unset;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 18L9 12L15 6" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <p>Settings</p>
            </div>

            <div class="modal-body">
              <p style="text-align: left;">
                You can add your wallet to dapp for debug,
                <a href="https://github.com/azbang/hot-connector" target="_blank">read the documentation.</a> Paste your manifest and click "Add".
              </p>

              <textarea style="width: 100%;" id="debug-manifest-input" rows="10">${JSON.stringify(Un,null,2)}</textarea>
              <button class="add-debug-manifest-button">Add</button>
            </div>

            ${this.footer}
          </div>
        </div>
      `:(0,j.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-header">
          <p>Select wallet</p>
          <button class="settings-button">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="19" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="5" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
            </svg>
          </button>
        </div>

        <div class="modal-body">${this.state.wallets.map(t=>this.walletDom(t))}</div>

        ${this.footer}
      </div>
    </div>`}};le.NearWalletsPopup=Re});var kt=w(ze=>{"use strict";Object.defineProperty(ze,"__esModule",{value:!0});var Ge=class{constructor(e,t){c(this,"dbName");c(this,"storeName");c(this,"version");this.dbName=e,this.storeName=t,this.version=1}getDb(){return new Promise((e,t)=>{if(typeof window>"u"||typeof indexedDB>"u"){t(new Error("IndexedDB is not available (SSR environment)"));return}let s=indexedDB.open(this.dbName,this.version);s.onerror=o=>{console.error("Error opening database:",o.target.error),t(new Error("Error opening database"))},s.onsuccess=o=>{e(s.result)},s.onupgradeneeded=o=>{let r=s.result;r.objectStoreNames.contains(this.storeName)||r.createObjectStore(this.storeName)}})}async getItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((s,o)=>{if(!this.storeName){o(new Error("Store name not set"));return}let r=t.transaction(this.storeName,"readonly");r.onerror=d=>o(r.error);let i=r.objectStore(this.storeName).get(e);i.onerror=d=>o(i.error),i.onsuccess=()=>{s(i.result),t.close()}})}async setItem(e,t){let s=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((o,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let a=s.transaction(this.storeName,"readwrite");a.onerror=u=>r(a.error);let d=a.objectStore(this.storeName).put(t,e);d.onerror=u=>r(d.error),d.onsuccess=()=>{s.close(),o()}})}async removeItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((s,o)=>{if(!this.storeName){o(new Error("Store name not set"));return}let r=t.transaction(this.storeName,"readwrite");r.onerror=d=>o(r.error);let i=r.objectStore(this.storeName).delete(e);i.onerror=d=>o(i.error),i.onsuccess=()=>{t.close(),s()}})}async keys(){let e=await this.getDb();return new Promise((t,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readonly");o.onerror=i=>s(o.error);let a=o.objectStore(this.storeName).getAllKeys();a.onerror=i=>s(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async count(){let e=await this.getDb();return new Promise((t,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readonly");o.onerror=i=>s(o.error);let a=o.objectStore(this.storeName).count();a.onerror=i=>s(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async length(){return this.count()}async clear(){let e=await this.getDb();return new Promise((t,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readwrite");o.onerror=i=>s(o.error);let a=o.objectStore(this.storeName).clear();a.onerror=i=>s(a.error),a.onsuccess=()=>{e.close(),t()}})}};ze.default=Ge});var Ct=w(L=>{"use strict";var Hn=L&&L.__importDefault||function(n){return n&&n.__esModule?n:{default:n}};Object.defineProperty(L,"__esModule",{value:!0});L.NearConnector=void 0;var Vn=Ce(),Yn=At(),Zn=pe(),Xn=Hn(kt()),Jn=ve(),Qn=Be(),St=Ke(),es=["https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json","https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json"];function ts(n){return e=>Object.entries(n).length===0?!0:Object.entries(n).filter(([t,s])=>s===!0).every(([t])=>e.manifest.features?.[t]===!0)}var Ue=class{constructor(e){c(this,"storage");c(this,"events");c(this,"db");c(this,"logger");c(this,"wallets",[]);c(this,"manifest",{wallets:[],version:"1.0.0"});c(this,"features",{});c(this,"network","mainnet");c(this,"providers",{mainnet:[],testnet:[]});c(this,"walletConnect");c(this,"footerBranding");c(this,"excludedWallets",[]);c(this,"autoConnect");c(this,"cspNonce");c(this,"whenManifestLoaded");c(this,"_handleNearWalletInjected",e=>{this.wallets=this.wallets.filter(t=>t.manifest.id!==e.detail.manifest.id),this.wallets.unshift(new Qn.InjectedWallet(this,e.detail)),this.events.emit("selector:walletsChanged",{})});this.db=new Xn.default("hot-connector","wallets"),this.storage=e?.storage??new Zn.LocalStorage,this.events=e?.events??new Vn.EventEmitter,this.logger=e?.logger,this.cspNonce=e?.cspNonce,this.network=e?.network??"mainnet",this.walletConnect=e?.walletConnect,this.autoConnect=e?.autoConnect??!0,this.providers=e?.providers??{mainnet:[],testnet:[]},this.excludedWallets=e?.excludedWallets??[],this.features=e?.features??{},e?.footerBranding!==void 0?this.footerBranding=e?.footerBranding:this.footerBranding={icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%20512%20512%22%20class%3D%22size-7%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%2300ec97%22%20rx%3D%22110%22%2F%3E%3Cpath%20fill%3D%22%23000%22%20d%3D%22M373.89%20106.199a31.95%2031.95%200%200%200-27.213%2015.207l-62.631%2092.979a6.67%206.67%200%200%200-.989%205.001%206.66%206.66%200%200%200%202.837%204.235%206.67%206.67%200%200%200%208.032-.494l61.643-53.47c1.02-.924%202.599-.827%203.523.193.419.473.644%201.074.644%201.697v167.402a2.49%202.49%200%200%201-2.502%202.491%202.48%202.48%200%200%201-1.912-.891L168.976%20117.497a31.93%2031.93%200%200%200-24.356-11.298h-6.508c-17.623%200-31.917%2014.294-31.917%2031.917v235.767c0%2017.623%2014.294%2031.917%2031.917%2031.917a31.94%2031.94%200%200%200%2027.213-15.206l62.631-92.98a6.66%206.66%200%200%200-1.847-9.236%206.67%206.67%200%200%200-8.033.494l-61.643%2053.471c-1.02.923-2.599.826-3.522-.194a2.5%202.5%200%200%201-.634-1.697V173.008a2.49%202.49%200%200%201%202.502-2.492c.731%200%201.439.322%201.912.891l186.313%20223.096a31.95%2031.95%200%200%200%2024.357%2011.297h6.508c17.623%200%2031.927-14.272%2031.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917%22%2F%3E%3C%2Fsvg%3E",heading:"NEAR Connector",link:"https://wallet.near.org",linkText:"Don't have a wallet?"},this.whenManifestLoaded=new Promise(async t=>{e?.manifest==null||typeof e.manifest=="string"?this.manifest=await this._loadManifest(e?.manifest).catch(()=>({wallets:[],version:"1.0.0"})):this.manifest=e?.manifest??{wallets:[],version:"1.0.0"};let s=new Set(this.excludedWallets);s.delete("hot-wallet"),this.manifest.wallets=this.manifest.wallets.filter(o=>!(o.permissions.walletConnect&&!this.walletConnect||s.has(o.id))),await new Promise(o=>setTimeout(o,100)),t()}),typeof window<"u"&&(window.addEventListener("near-wallet-injected",this._handleNearWalletInjected),window.dispatchEvent(new Event("near-selector-ready")),window.addEventListener("message",async t=>{t.data.type==="near-wallet-injected"&&(await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.filter(s=>s.manifest.id!==t.data.manifest.id),this.wallets.unshift(new Jn.ParentFrameWallet(this,t.data.manifest)),this.events.emit("selector:walletsChanged",{}),this.autoConnect&&this.connect({walletId:t.data.manifest.id}))})),this.whenManifestLoaded.then(()=>{typeof window<"u"&&window.parent.postMessage({type:"near-selector-ready"},"*"),this.manifest.wallets.forEach(t=>this.registerWallet(t)),this.storage.get("debug-wallets").then(t=>{JSON.parse(t??"[]").forEach(o=>this.registerDebugWallet(o))})})}get availableWallets(){return this.wallets.filter(t=>Object.entries(this.features).every(([s,o])=>!(o&&!t.manifest.features?.[s]))).filter(t=>!(this.network==="testnet"&&!t.manifest.features?.testnet))}async _loadManifest(e){let t=e?[e]:es;for(let s of t){let o=await fetch(s).catch(()=>null);if(!(!o||!o.ok))return await o.json()}throw new Error("Failed to load manifest")}async switchNetwork(e,t){this.network!==e&&(await this.disconnect().catch(()=>{}),this.network=e,await this.connect(t))}async registerWallet(e){if(e.type!=="sandbox")throw new Error("Only sandbox wallets are supported");this.wallets.find(t=>t.manifest.id===e.id)||(this.wallets.push(new St.SandboxWallet(this,e)),this.events.emit("selector:walletsChanged",{}))}async registerDebugWallet(e){let t=typeof e=="string"?JSON.parse(e):e;if(t.type!=="sandbox")throw new Error("Only sandbox wallets type are supported");if(!t.id)throw new Error("Manifest must have an id");if(!t.name)throw new Error("Manifest must have a name");if(!t.icon)throw new Error("Manifest must have an icon");if(!t.website)throw new Error("Manifest must have a website");if(!t.version)throw new Error("Manifest must have a version");if(!t.executor)throw new Error("Manifest must have an executor");if(!t.features)throw new Error("Manifest must have features");if(!t.permissions)throw new Error("Manifest must have permissions");if(this.wallets.find(o=>o.manifest.id===t.id))throw new Error("Wallet already registered");t.debug=!0,this.wallets.unshift(new St.SandboxWallet(this,t)),this.events.emit("selector:walletsChanged",{});let s=this.wallets.filter(o=>o.manifest.debug).map(o=>o.manifest);return this.storage.set("debug-wallets",JSON.stringify(s)),t}async removeDebugWallet(e){this.wallets=this.wallets.filter(s=>s.manifest.id!==e);let t=this.wallets.filter(s=>s.manifest.debug).map(s=>s.manifest);this.storage.set("debug-wallets",JSON.stringify(t)),this.events.emit("selector:walletsChanged",{})}async selectWallet({features:e={}}={}){return await this.whenManifestLoaded.catch(()=>{}),new Promise((t,s)=>{let o=new Yn.NearWalletsPopup({footer:this.footerBranding,wallets:this.availableWallets.filter(ts(e)).map(r=>r.manifest),onRemoveDebugManifest:async r=>this.removeDebugWallet(r),onAddDebugManifest:async r=>this.registerDebugWallet(r),onReject:()=>(s(new Error("User rejected")),o.destroy()),onSelect:r=>(t(r),o.destroy())});o.create()})}async connect(e={}){let t=e.walletId,s=e.signMessageParams;await this.whenManifestLoaded.catch(()=>{}),t||(t=await this.selectWallet({features:{signInAndSignMessage:e.signMessageParams!=null?!0:void 0,signInWithFunctionCallKey:e.addFunctionCallKey!=null?!0:void 0}}));try{let o=await this.wallet(t);this.logger?.log("Wallet available to connect",o),await this.storage.set("selected-wallet",t),this.logger?.log(`Set preferred wallet, try to signIn${s!=null?" (with signed message)":""}`,t);let r;if(e.addFunctionCallKey!=null&&(this.logger?.log("Adding function call access key during sign in with params",e.addFunctionCallKey),r={...e.addFunctionCallKey,gasAllowance:e.addFunctionCallKey.gasAllowance??{amount:"250000000000000000000000",kind:"limited"}}),s!=null){let a=await o.signInAndSignMessage({addFunctionCallKey:r,messageParams:s,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet (with signed message)",t,a),this.events.emit("wallet:signInAndSignMessage",{wallet:o,accounts:a,success:!0}),this.events.emit("wallet:signIn",{wallet:o,accounts:a.map(i=>({accountId:i.accountId,publicKey:i.publicKey})),success:!0,source:"signInAndSignMessage"})}else{let a=await o.signIn({addFunctionCallKey:r,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet",t,a),this.events.emit("wallet:signIn",{wallet:o,accounts:a,success:!0,source:"signIn"})}return o}catch(o){throw this.logger?.log("Failed to connect to wallet",o),o}}async disconnect(e){e||(e=await this.wallet()),await e.signOut({network:this.network}),await this.storage.remove("selected-wallet"),this.events.emit("wallet:signOut",{success:!0})}async getConnectedWallet(){await this.whenManifestLoaded.catch(()=>{});let e=await this.storage.get("selected-wallet"),t=this.wallets.find(o=>o.manifest.id===e);if(!t)throw new Error("No wallet selected");let s=await t.getAccounts();if(!s?.length)throw new Error("No accounts found");return{wallet:t,accounts:s}}async wallet(e){if(await this.whenManifestLoaded.catch(()=>{}),!e)return this.getConnectedWallet().then(({wallet:s})=>s).catch(async()=>{throw await this.storage.remove("selected-wallet"),new Error("No accounts found")});let t=this.wallets.find(s=>s.manifest.id===e);if(!t)throw new Error("Wallet not found");return t}async use(e){await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.map(t=>new Proxy(t,{get(s,o,r){let a=Reflect.get(s,o,r);if(o in e&&typeof a=="function"){let i=e[o];return function(...d){let u=()=>a.apply(s,d);return d.length>0?i.call(this,...d,u):i.call(this,void 0,u)}}return a}}))}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeAllListeners(e){this.events.removeAllListeners(e)}};L.NearConnector=Ue});var Pt=w(p=>{"use strict";Object.defineProperty(p,"__esModule",{value:!0});p.assertGasKeyActionsSupported=p.isGasKeyAction=p.nearActionsToConnectorActions=p.NearConnector=p.InjectedWallet=p.SandboxWallet=p.ParentFrameWallet=p.LocalStorage=void 0;var ns=pe();Object.defineProperty(p,"LocalStorage",{enumerable:!0,get:function(){return ns.LocalStorage}});var ss=ve();Object.defineProperty(p,"ParentFrameWallet",{enumerable:!0,get:function(){return ss.ParentFrameWallet}});var os=Ke();Object.defineProperty(p,"SandboxWallet",{enumerable:!0,get:function(){return os.SandboxWallet}});var rs=Be();Object.defineProperty(p,"InjectedWallet",{enumerable:!0,get:function(){return rs.InjectedWallet}});var as=Ct();Object.defineProperty(p,"NearConnector",{enumerable:!0,get:function(){return as.NearConnector}});var is=q();Object.defineProperty(p,"nearActionsToConnectorActions",{enumerable:!0,get:function(){return is.nearActionsToConnectorActions}});var _t=F();Object.defineProperty(p,"isGasKeyAction",{enumerable:!0,get:function(){return _t.isGasKeyAction}});Object.defineProperty(p,"assertGasKeyActionsSupported",{enumerable:!0,get:function(){return _t.assertGasKeyActionsSupported}})});var Cs=ln(Pt());var Yt={};an(Yt,{CURVE:()=>Wt,ExtendedPoint:()=>S,Point:()=>S,etc:()=>at,getPublicKey:()=>ps,getPublicKeyAsync:()=>gs,sign:()=>ys,signAsync:()=>ms,utils:()=>vs,verify:()=>xs,verifyAsync:()=>bs});var Wt={p:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,n:0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,h:8n,a:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,d:0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,Gx:0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,Gy:0x6666666666666666666666666666666666666666666666666666666666666658n},{p:m,n:de,Gx:Et,Gy:It,a:He,d:Ve}=Wt,cs=8n,k=32,R=64,y=(n="")=>{throw new Error(n)},ls=n=>typeof n=="bigint",jt=n=>typeof n=="string",ds=n=>n instanceof Uint8Array||ArrayBuffer.isView(n)&&n.constructor.name==="Uint8Array",N=(n,e)=>!ds(n)||typeof e=="number"&&e>0&&n.length!==e?y("Uint8Array expected"):n,we=n=>new Uint8Array(n),Xe=n=>Uint8Array.from(n),Lt=(n,e)=>n.toString(16).padStart(e,"0"),Je=n=>Array.from(N(n)).map(e=>Lt(e,2)).join(""),C={_0:48,_9:57,A:65,F:70,a:97,f:102},Mt=n=>{if(n>=C._0&&n<=C._9)return n-C._0;if(n>=C.A&&n<=C.F)return n-(C.A-10);if(n>=C.a&&n<=C.f)return n-(C.a-10)},Qe=n=>{let e="hex invalid";if(!jt(n))return y(e);let t=n.length,s=t/2;if(t%2)return y(e);let o=we(s);for(let r=0,a=0;r<s;r++,a+=2){let i=Mt(n.charCodeAt(a)),d=Mt(n.charCodeAt(a+1));if(i===void 0||d===void 0)return y(e);o[r]=i*16+d}return o},E=(n,e)=>N(jt(n)?Qe(n):Xe(N(n)),e),Kt=()=>globalThis?.crypto,us=()=>Kt()?.subtle??y("crypto.subtle must be defined"),G=(...n)=>{let e=we(n.reduce((s,o)=>s+N(o).length,0)),t=0;return n.forEach(s=>{e.set(s,t),t+=s.length}),e},qt=(n=k)=>Kt().getRandomValues(we(n)),ue=BigInt,$=(n,e,t,s="bad number: out of range")=>ls(n)&&e<=n&&n<t?n:y(s),l=(n,e=m)=>{let t=n%e;return t>=0n?t:e+t},Ft=n=>l(n,de),Dt=(n,e)=>{(n===0n||e<=0n)&&y("no inverse n="+n+" mod="+e);let t=l(n,e),s=e,o=0n,r=1n,a=1n,i=0n;for(;t!==0n;){let d=s/t,u=s%t,f=o-a*d,h=r-i*d;s=t,t=u,o=a,r=i,a=f,i=h}return s===1n?l(o,e):y("no inverse")},fs=n=>{let e=at[n];return typeof e!="function"&&y("hashes."+n+" not set"),e},$t=n=>n instanceof S?n:y("Point expected"),Ye=2n**256n,A=class A{constructor(e,t,s,o){c(this,"ex");c(this,"ey");c(this,"ez");c(this,"et");let r=Ye;this.ex=$(e,0n,r),this.ey=$(t,0n,r),this.ez=$(s,1n,r),this.et=$(o,0n,r),Object.freeze(this)}static fromAffine(e){return new A(e.x,e.y,1n,l(e.x*e.y))}static fromBytes(e,t=!1){let s=Ve,o=Xe(N(e,k)),r=e[31];o[31]=r&-129;let a=et(o);$(a,0n,t?Ye:m);let d=l(a*a),u=l(d-1n),f=l(s*d+1n),{isValid:h,value:g}=ws(u,f);h||y("bad point: y not sqrt");let b=(g&1n)===1n,x=(r&128)!==0;return!t&&g===0n&&x&&y("bad point: x==0, isLastByteOdd"),x!==b&&(g=l(-g)),new A(g,a,1n,l(g*a))}assertValidity(){let e=He,t=Ve,s=this;if(s.is0())throw new Error("bad point: ZERO");let{ex:o,ey:r,ez:a,et:i}=s,d=l(o*o),u=l(r*r),f=l(a*a),h=l(f*f),g=l(d*e),b=l(f*l(g+u)),x=l(h+l(t*l(d*u)));if(b!==x)throw new Error("bad point: equation left != right (1)");let T=l(o*r),O=l(a*i);if(T!==O)throw new Error("bad point: equation left != right (2)");return this}equals(e){let{ex:t,ey:s,ez:o}=this,{ex:r,ey:a,ez:i}=$t(e),d=l(t*i),u=l(r*o),f=l(s*i),h=l(a*o);return d===u&&f===h}is0(){return this.equals(K)}negate(){return new A(l(-this.ex),this.ey,this.ez,l(-this.et))}double(){let{ex:e,ey:t,ez:s}=this,o=He,r=l(e*e),a=l(t*t),i=l(2n*l(s*s)),d=l(o*r),u=e+t,f=l(l(u*u)-r-a),h=d+a,g=h-i,b=d-a,x=l(f*g),T=l(h*b),O=l(f*b),z=l(g*h);return new A(x,T,z,O)}add(e){let{ex:t,ey:s,ez:o,et:r}=this,{ex:a,ey:i,ez:d,et:u}=$t(e),f=He,h=Ve,g=l(t*a),b=l(s*i),x=l(r*h*u),T=l(o*d),O=l((t+s)*(a+i)-g-b),z=l(T-x),it=l(T+x),ct=l(b-f*g),Zt=l(O*z),Xt=l(it*ct),Jt=l(O*ct),Qt=l(z*it);return new A(Zt,Xt,Qt,Jt)}multiply(e,t=!0){if(!t&&(e===0n||this.is0()))return K;if($(e,1n,de),e===1n)return this;if(this.equals(_))return Ss(e).p;let s=K,o=_;for(let r=this;e>0n;r=r.double(),e>>=1n)e&1n?s=s.add(r):t&&(o=o.add(r));return s}toAffine(){let{ex:e,ey:t,ez:s}=this;if(this.equals(K))return{x:0n,y:1n};let o=Dt(s,m);return l(s*o)!==1n&&y("invalid inverse"),{x:l(e*o),y:l(t*o)}}toBytes(){let{x:e,y:t}=this.assertValidity().toAffine(),s=Bt(t);return s[31]|=e&1n?128:0,s}toHex(){return Je(this.toBytes())}clearCofactor(){return this.multiply(ue(cs),!1)}isSmallOrder(){return this.clearCofactor().is0()}isTorsionFree(){let e=this.multiply(de/2n,!1).double();return de%2n&&(e=e.add(this)),e.is0()}static fromHex(e,t){return A.fromBytes(E(e),t)}get x(){return this.toAffine().x}get y(){return this.toAffine().y}toRawBytes(){return this.toBytes()}};c(A,"BASE"),c(A,"ZERO");var S=A,_=new S(Et,It,1n,l(Et*It)),K=new S(0n,1n,1n,0n);S.BASE=_;S.ZERO=K;var Bt=n=>Qe(Lt($(n,0n,Ye),R)).reverse(),et=n=>ue("0x"+Je(Xe(N(n)).reverse())),v=(n,e)=>{let t=n;for(;e-- >0n;)t*=t,t%=m;return t},hs=n=>{let t=n*n%m*n%m,s=v(t,2n)*t%m,o=v(s,1n)*n%m,r=v(o,5n)*o%m,a=v(r,10n)*r%m,i=v(a,20n)*a%m,d=v(i,40n)*i%m,u=v(d,80n)*d%m,f=v(u,80n)*d%m,h=v(f,10n)*r%m;return{pow_p_5_8:v(h,2n)*n%m,b2:t}},Nt=0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n,ws=(n,e)=>{let t=l(e*e*e),s=l(t*t*e),o=hs(n*s).pow_p_5_8,r=l(n*t*o),a=l(e*r*r),i=r,d=l(r*Nt),u=a===n,f=a===l(-n),h=a===l(-n*Nt);return u&&(r=i),(f||h)&&(r=d),(l(r)&1n)===1n&&(r=l(-r)),{isValid:u||f,value:r}},fe=n=>Ft(et(n)),tt=(...n)=>at.sha512Async(...n),nt=(...n)=>fs("sha512Sync")(...n),Rt=n=>{let e=n.slice(0,k);e[0]&=248,e[31]&=127,e[31]|=64;let t=n.slice(k,R),s=fe(e),o=_.multiply(s),r=o.toBytes();return{head:e,prefix:t,scalar:s,point:o,pointBytes:r}},st=n=>tt(E(n,k)).then(Rt),ot=n=>Rt(nt(E(n,k))),gs=n=>st(n).then(e=>e.pointBytes),ps=n=>ot(n).pointBytes,Gt=n=>tt(n.hashable).then(n.finish),zt=n=>n.finish(nt(n.hashable)),Ut=(n,e,t)=>{let{pointBytes:s,scalar:o}=n,r=fe(e),a=_.multiply(r).toBytes();return{hashable:G(a,s,t),finish:u=>{let f=Ft(r+fe(u)*o);return N(G(a,Bt(f)),R)}}},ms=async(n,e)=>{let t=E(n),s=await st(e),o=await tt(s.prefix,t);return Gt(Ut(s,o,t))},ys=(n,e)=>{let t=E(n),s=ot(e),o=nt(s.prefix,t);return zt(Ut(s,o,t))},rt={zip215:!0},Ht=(n,e,t,s=rt)=>{n=E(n,R),e=E(e),t=E(t,k);let{zip215:o}=s,r,a,i,d,u=Uint8Array.of();try{r=S.fromHex(t,o),a=S.fromHex(n.slice(0,k),o),i=et(n.slice(k,R)),d=_.multiply(i,!1),u=G(a.toBytes(),r.toBytes(),e)}catch{}return{hashable:u,finish:h=>{if(d==null||!o&&r.isSmallOrder())return!1;let g=fe(h);return a.add(r.multiply(g,!1)).add(d.negate()).clearCofactor().is0()}}},bs=async(n,e,t,s=rt)=>Gt(Ht(n,e,t,s)),xs=(n,e,t,s=rt)=>zt(Ht(n,e,t,s)),at={sha512Async:async(...n)=>{let e=us(),t=G(...n);return we(await e.digest("SHA-512",t.buffer))},sha512Sync:void 0,bytesToHex:Je,hexToBytes:Qe,concatBytes:G,mod:l,invert:Dt,randomBytes:qt},vs={getExtendedPublicKeyAsync:st,getExtendedPublicKey:ot,randomPrivateKey:()=>qt(k),precompute:(n=8,e=_)=>(e.multiply(3n),e)},he=8,As=256,Vt=Math.ceil(As/he)+1,Ze=2**(he-1),ks=()=>{let n=[],e=_,t=e;for(let s=0;s<Vt;s++){t=e,n.push(t);for(let o=1;o<Ze;o++)t=t.add(e),n.push(t);e=t.double()}return n},Tt,Ot=(n,e)=>{let t=e.negate();return n?t:e},Ss=n=>{let e=Tt||(Tt=ks()),t=K,s=_,o=2**he,r=o,a=ue(o-1),i=ue(he);for(let d=0;d<Vt;d++){let u=Number(n&a);n>>=i,u>Ze&&(u-=r,n+=1n);let f=d*Ze,h=f,g=f+Math.abs(u)-1,b=d%2!==0,x=u<0;u===0?s=s.add(Ot(b,e[h])):t=t.add(Ot(x,e[g]))}return{p:t,f:s}};var export_NearConnector=Cs.NearConnector;export{export_NearConnector as NearConnector,Yt as ed};
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)
*/
