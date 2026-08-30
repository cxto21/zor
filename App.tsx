
import React, { useState, useEffect, useCallback } from 'react';
import RetroWindow from './components/RetroWindow';
import WalletConnect from './components/WalletConnect';
import { getPrivacyTip, generateNodeLog } from './services/geminiService';
import { AppSection, ZKProofLog, WikiEntry } from './types';

const WIKI_DATA: WikiEntry[] = [
  {
    id: 'server-setup',
    title: 'Linux Relay Node Setup',
    category: 'SETUP',
    content: '1. apt-get update && apt-get install zor-relay\n2. zor-relay --init --starknet-wallet <YOUR_ADDR>\n3. Configure port 9050 forwarding.\n4. Run: systemctl start zor-node'
  },
  {
    id: 'whatsapp-proxy',
    title: 'WhatsApp Bridge (WAP)',
    category: 'PROTOCOL',
    content: 'Navigate the web via WhatsApp. Send "PROXY <url>" to +1-ZOR-ZK-LINE. The server returns a ZK-compressed text version of the page. No direct data connection required.'
  },
  {
    id: 'openvpn-int',
    title: 'OpenVPN Integration',
    category: 'SETUP',
    content: 'Download the .ovpn config from the VPN tab. Import into your client. Authentication is handled via a ZK-STARK signature from your connected Starknet wallet.'
  }
];

const App: React.FC = () => {
  const [section, setSection] = useState<AppSection>(AppSection.HOME);
  const [tip, setTip] = useState<string>("Loading privacy wisdom...");
  const [logs, setLogs] = useState<ZKProofLog[]>([]);
  const [isNodeActive, setIsNodeActive] = useState(false);
  const [rewards, setRewards] = useState(0);
  const [rewardMultiplier, setRewardMultiplier] = useState(1);
  const [account, setAccount] = useState<any>(null);
  const [isVpnActive, setIsVpnActive] = useState(false);

  // Load initial tip
  useEffect(() => {
    getPrivacyTip().then(setTip);
  }, []);

  // Log simulation
  useEffect(() => {
    if (!isNodeActive) return;

    const interval = setInterval(async () => {
      const logMessage = await generateNodeLog();
      setLogs(prev => [
        { 
          timestamp: new Date().toLocaleTimeString(), 
          message: logMessage, 
          type: Math.random() > 0.1 ? 'info' : 'success' 
        },
        ...prev.slice(0, 14)
      ]);
      setRewards(prev => prev + (0.001 * rewardMultiplier));
    }, 4000);

    return () => clearInterval(interval);
  }, [isNodeActive, rewardMultiplier]);

  const boostRewards = () => {
    if (rewardMultiplier < 2) {
      setRewardMultiplier(2);
      alert("REWARD AMPLIFIER ACTIVATED: X2 EARNINGS ENGAGED!");
    }
  };

  const renderHome = () => (
    <div className="space-y-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-blue-800 mb-2 font-['VT323'] tracking-widest">ZOR NETWORK</h1>
        <p className="text-sm italic">"Your path to the decentralized unseen."</p>
      </div>
      
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed">
            Welcome to <strong>Zor</strong>. The first anonymous infrastructure layer with 
            <strong> Zero-Knowledge Rewards</strong>.
          </p>
          <div className="border-2 border-double border-blue-500 p-2 text-xs bg-blue-50">
            <h4 className="font-bold text-blue-600 uppercase">Latest News:</h4>
            WhatsApp Bridge alpha is now live! Browse without a data plan.
          </div>
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className="w-32 h-32 border-4 border-gray-400 bg-gray-300 flex items-center justify-center text-4xl shadow-inner">
            🌍
          </div>
          <span className="text-[10px] uppercase mt-2">v0.92-STABLE</span>
        </div>
      </div>

      <div className="retro-border-inset p-2 bg-black text-green-500 font-mono text-xs">
        <p>ACTIVE RELAYS: 5,102</p>
        <p>ZK-CIRCUITS: VERIFIED</p>
        <p>WHATSAPP BRIDGE: ONLINE</p>
      </div>
    </div>
  );

  const renderNode = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold underline">NODE CONTROL</h2>
        <div className={`px-2 py-1 text-xs font-bold ${isNodeActive ? 'bg-green-500 text-white animate-pulse' : 'bg-red-500 text-white'}`}>
          {isNodeActive ? 'RELAYING' : 'IDLE'}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div className="retro-border-inset p-2 bg-gray-50 col-span-1">
          <span className="block text-gray-500 text-[10px] uppercase">Balance</span>
          <span className="text-lg font-bold">{rewards.toFixed(4)} $ZOR</span>
        </div>
        <div className="retro-border-inset p-2 bg-gray-50 col-span-1">
          <span className="block text-gray-500 text-[10px] uppercase">Boost</span>
          <span className="text-lg font-bold text-orange-600">x{rewardMultiplier}</span>
        </div>
        <div className="retro-border-inset p-2 bg-blue-900 text-white col-span-1 flex items-center justify-center">
          <button onClick={boostRewards} className="text-[10px] font-bold uppercase animate-pulse">AMPLIFY →</button>
        </div>
      </div>

      <div className="flex gap-2">
        <button 
          onClick={() => setIsNodeActive(!isNodeActive)}
          className="retro-border retro-button bg-[#c0c0c0] flex-1 py-2 font-bold"
        >
          {isNodeActive ? 'HALT SYSTEM' : 'BOOT RELAY'}
        </button>
        <button 
          disabled={rewards === 0}
          className="retro-border retro-button bg-[#c0c0c0] px-4 py-2 font-bold disabled:opacity-50"
        >
          CLAIM
        </button>
      </div>

      <div className="retro-border-inset bg-black p-2 h-40 overflow-y-auto font-mono text-[10px] text-green-400">
        {logs.map((log, idx) => (
          <div key={idx} className="mb-1">
            <span className="text-gray-500">[{log.timestamp}]</span> {log.message}
          </div>
        ))}
      </div>
    </div>
  );

  const renderVPN = () => (
    <div className="space-y-4">
      <h2 className="text-xl font-bold underline uppercase">Proactive VPN Purchase</h2>
      <p className="text-xs">Secure your tunnel before you browse. Zero-Knowledge proofs ensure your payment address is never linked to your VPN session ID.</p>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="retro-border p-3 space-y-2 bg-gray-100">
          <h3 className="font-bold text-xs uppercase border-b border-black">Plan A: Hourly</h3>
          <p className="text-sm font-bold">0.02 $STRK</p>
          <button className="w-full retro-border retro-button bg-blue-700 text-white text-[10px] py-1">PURCHASE</button>
        </div>
        <div className="retro-border p-3 space-y-2 bg-blue-50 border-blue-500">
          <h3 className="font-bold text-xs uppercase border-b border-blue-500">Plan B: Daily</h3>
          <p className="text-sm font-bold">0.40 $STRK</p>
          <button className="w-full retro-border retro-button bg-green-700 text-white text-[10px] py-1">PURCHASE</button>
        </div>
      </div>

      <div className="retro-border-inset p-4 bg-white">
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-bold uppercase">VPN STATUS:</span>
          <span className={isVpnActive ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>{isVpnActive ? 'CONNECTED' : 'DISCONNECTED'}</span>
        </div>
        <button 
          onClick={() => setIsVpnActive(!isVpnActive)}
          className={`w-full py-2 font-bold retro-border ${isVpnActive ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`}
        >
          {isVpnActive ? 'KILL SWITCH' : 'ESTABLISH TUNNEL'}
        </button>
      </div>

      <div className="flex items-center gap-2 p-2 bg-green-100 border border-green-600">
        <span className="text-xl">💬</span>
        <div className="text-[10px]">
          <strong>NEW:</strong> WhatsApp Proxy mode enabled. Configure in Wiki.
        </div>
      </div>
    </div>
  );

  const renderWiki = () => (
    <div className="space-y-4">
      <h2 className="text-xl font-bold underline uppercase">ZOR Knowledge Base</h2>
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {['ALL', 'SETUP', 'PROTOCOL'].map(cat => (
          <button key={cat} className="text-[10px] retro-border bg-gray-200 px-2 py-1 uppercase font-bold">{cat}</button>
        ))}
      </div>
      <div className="space-y-4">
        {WIKI_DATA.map(entry => (
          <div key={entry.id} className="retro-border-inset p-3 bg-white">
            <div className="flex justify-between items-start mb-1">
              <h3 className="font-bold text-sm text-blue-800">{entry.title}</h3>
              <span className="text-[8px] bg-gray-200 px-1 font-bold">{entry.category}</span>
            </div>
            <pre className="text-[10px] whitespace-pre-wrap font-mono bg-gray-50 p-2 border border-dashed border-gray-400">
              {entry.content}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );

  const renderRoadmap = () => (
    <div className="space-y-4">
      <h2 className="text-xl font-bold underline uppercase text-red-700">Project Roadmap</h2>
      <div className="relative border-l-2 border-black ml-4 pl-6 py-2 space-y-6">
        <div className="relative">
          <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-green-500 border-2 border-black"></div>
          <h4 className="font-bold text-sm uppercase">Q2 2024: The Foundation (Current)</h4>
          <p className="text-[10px]">Launch of Zor Web Proxy and ZK-Reward incentives on Starknet Mainnet.</p>
        </div>
        <div className="relative">
          <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-blue-500 border-2 border-black animate-pulse"></div>
          <h4 className="font-bold text-sm uppercase">Q3 2024: Mobile Privacy</h4>
          <p className="text-[10px]">Release of Zor Mobile for Android and iOS. Integrated Tongo wallet for one-tap anonymous browsing.</p>
        </div>
        <div className="relative opacity-60">
          <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-gray-400 border-2 border-black"></div>
          <h4 className="font-bold text-sm uppercase">Q4 2024: WhatsApp Full Bridge</h4>
          <p className="text-[10px]">Global rollout of SMS and WhatsApp data bridges for users in high-censorship zones.</p>
        </div>
        <div className="relative opacity-40">
          <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-gray-400 border-2 border-black"></div>
          <h4 className="font-bold text-sm uppercase">2025: ISP-Level Zor Protocol</h4>
          <p className="text-[10px]">Partnerships with decentralized ISPs to bake Zor privacy directly into hardware relays.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-5xl mx-auto crt relative">
      <header className="mb-6">
        <div className="retro-border bg-[#c0c0c0] mb-4">
          <marquee scrollamount="5">
            ZOR_NET :: WHATSAPP BRIDGE ALPHA NOW LIVE :: MOBILE VERSION COMING Q3 2024 :: AMPLIFY YOUR NODE REWARDS NOW :: STARKNET ZK-PROOFS VERIFIED ::
          </marquee>
        </div>
        <div className="flex flex-wrap gap-2 items-center bg-[#c0c0c0] retro-border p-2">
          <button onClick={() => setSection(AppSection.HOME)} className={`px-4 py-1 text-[10px] font-bold retro-border ${section === AppSection.HOME ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}>HOME</button>
          <button onClick={() => setSection(AppSection.NODE)} className={`px-4 py-1 text-[10px] font-bold retro-border ${section === AppSection.NODE ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}>NODE</button>
          <button onClick={() => setSection(AppSection.VPN)} className={`px-4 py-1 text-[10px] font-bold retro-border ${section === AppSection.VPN ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}>VPN</button>
          <button onClick={() => setSection(AppSection.WIKI)} className={`px-4 py-1 text-[10px] font-bold retro-border ${section === AppSection.WIKI ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}>WIKI</button>
          <button onClick={() => setSection(AppSection.ROADMAP)} className={`px-4 py-1 text-[10px] font-bold retro-border ${section === AppSection.ROADMAP ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}>ROADMAP</button>
          <div className="flex-1 text-right text-[8px] font-bold text-blue-900 pr-2 italic">
            ZOR_OS 1.0.RC2
          </div>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <section className="lg:col-span-3">
          <RetroWindow title={`ZOR:\\${section}.EXE`} className="h-full min-h-[550px]">
            {section === AppSection.HOME && renderHome()}
            {section === AppSection.NODE && renderNode()}
            {section === AppSection.VPN && renderVPN()}
            {section === AppSection.WIKI && renderWiki()}
            {section === AppSection.ROADMAP && renderRoadmap()}
          </RetroWindow>
        </section>

        <aside className="space-y-6">
          <RetroWindow title="TONGO_WALLET" icon="💼">
            <WalletConnect onAccountChange={setAccount} />
          </RetroWindow>

          <RetroWindow title="ZK_ORACLE" icon="🧠">
            <p className="text-[10px] leading-tight mb-2 italic">"{tip}"</p>
            <button 
              onClick={async () => {
                setTip("Consulting the Oracle...");
                const newTip = await getPrivacyTip();
                setTip(newTip);
              }}
              className="text-[10px] text-blue-600 underline font-bold"
            >
              [Regenerate]
            </button>
          </RetroWindow>

          <div className="retro-border p-4 bg-gray-200 space-y-2">
            <h4 className="text-[10px] font-bold uppercase underline">Traffic Monitor</h4>
            <div className="w-full h-24 bg-black border-2 border-white relative overflow-hidden">
               <div className="absolute inset-0 flex items-center justify-around opacity-40">
                  <div className="w-1 h-12 bg-green-500 animate-pulse"></div>
                  <div className="w-1 h-8 bg-green-500 animate-bounce"></div>
                  <div className="w-1 h-16 bg-green-500 animate-pulse delay-75"></div>
                  <div className="w-1 h-10 bg-green-500 animate-bounce delay-150"></div>
               </div>
               <div className="absolute bottom-1 right-1 text-[8px] text-green-500 font-mono">
                  B/W: 420kbps
               </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="mt-8 flex justify-between items-center bg-[#c0c0c0] retro-border p-1 px-4 text-[10px] font-bold">
        <div className="flex items-center gap-2">
          <div className="retro-border px-2 py-0.5 shadow-inner">START</div>
          <div className="flex gap-2 text-gray-700">
            <span>[Node: {isNodeActive ? 'ON' : 'OFF'}]</span>
            <span>[VPN: {isVpnActive ? 'ON' : 'OFF'}]</span>
          </div>
        </div>
        <div className="flex gap-4">
          <div className="retro-border-inset px-2 flex items-center gap-1">
             <span className="text-green-600">●</span> 100%_ANONYMOUS
          </div>
          <div className="retro-border-inset px-2">SYSTEM_STABLE</div>
        </div>
      </footer>
    </div>
  );
};

export default App;
