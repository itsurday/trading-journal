import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";

const SETUPS   = ["Breakout","Reversal","Earnings Play","Sector Rotation","Macro Hedge","Gap and Go","VWAP Reclaim","Support Bounce","Imported"];
const EMOTIONS = ["Confident","Neutral","Excited","Fearful","Frustrated","Calm"];
const ALL_TAGS = ["momentum","reversal","earnings","tech","hedge","index","breakout","swing"];

const FIDELITY_SAMPLE = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
03/11/2026,"Individual - TOD","Z12345","YOU BOUGHT",AAPL,"APPLE INC",Cash,182.50,50,,,,9125.00,03/13/2026
03/18/2026,"Individual - TOD","Z12345","YOU SOLD",AAPL,"APPLE INC",Cash,191.20,50,,,,9560.00,03/20/2026
03/05/2026,"Individual - TOD","Z12345","YOU SOLD SHORT SALE TSLA (Short)",TSLA,"TESLA INC",Short,175.00,-25,,,,4375.00,03/07/2026
03/12/2026,"Individual - TOD","Z12345","YOU BOUGHT TO COVER",TSLA,"TESLA INC",Short,162.30,25,,,,4057.50,03/14/2026`;

const ROBINHOOD_SAMPLE = `symbol,date,order type,side,fees,quantity,average price
AAPL,2026-05-01T09:35:00Z,market,buy,0,50,182.50
AAPL,2026-05-08T14:20:00Z,market,sell,0,50,191.20
TSLA,2026-05-05T10:05:00Z,market,sell,0,30,175.00
TSLA,2026-05-12T11:45:00Z,market,buy,0,30,162.30
NVDA,2026-05-10T09:31:00Z,market,buy,0,20,875.00
NVDA,2026-05-18T15:55:00Z,market,sell,0,20,920.50`;

function parseCSVLine(line) {
  const result = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQ = !inQ; continue; }
    if (line[i] === ',' && !inQ) { result.push(cur.trim()); cur = ""; continue; }
    cur += line[i];
  }
  result.push(cur.trim()); return result;
}

function parseCSV(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = clean.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    const l = allLines[i].trim();
    if (l && l.toLowerCase().includes('run date') && l.toLowerCase().includes('action')) { headerIdx = i; break; }
    if (l && l.toLowerCase().includes('symbol') && l.toLowerCase().includes('side')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = allLines.findIndex(l => l.trim().length > 0);
  const headers = parseCSVLine(allLines[headerIdx]).map(h => h.toLowerCase().replace(/[$()]/g,'').replace(/\s+/g,' ').trim());
  const rows = [];
  for (let i = headerIdx + 1; i < allLines.length; i++) {
    const l = allLines[i].trim();
    if (!l) continue;
    if (!l.match(/^["']?\d{1,2}\/\d{1,2}\/\d{4}/) && !l.match(/^[A-Z]{1,6},/)) continue;
    const vals = parseCSVLine(l);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()])));
  }
  return { headers, rows };
}

function detectBroker(headers) {
  const h = headers.join('|');
  if (h.includes('run date') && h.includes('action') && h.includes('symbol')) return 'fidelity';
  if (h.includes('average price') && h.includes('side') && h.includes('symbol')) return 'robinhood';
  return 'unknown';
}

function toISO(dateStr) {
  if (!dateStr) return '';
  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
  const iso = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return dateStr.slice(0,10);
}

function cleanNum(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[^\d.\-]/g, '').replace(/\u2212/g, '-')) || 0;
}

function parseFidelity(rows) {
  const buys = {}, sells = {};
  rows.forEach(r => {
    const action = (r['action'] || '').toLowerCase();
    const sym    = (r['symbol'] || '').trim().toUpperCase();
    if (!sym || sym.length > 6 || !sym.match(/^[A-Z]/)) return;
    const price = Math.abs(cleanNum(r['price'] || r['price '] || ''));
    const qty   = Math.abs(cleanNum(r['quantity'] || ''));
    const date  = toISO(r['run date'] || r['settlement date'] || '');
    if (!price || !qty || !date) return;
    const isShortCover = action.includes('cover');
    const isShortSell  = action.includes('short') && action.includes('sold') && !isShortCover;
    const isBuy        = action.includes('bought') && !isShortCover;
    const isSell       = action.includes('sold') && !isShortSell && !isShortCover;
    const entry = { sym, qty, price, date };
    if (isBuy)        { (buys[sym]  = buys[sym] ||[]).push({...entry, direction:'LONG'});  }
    if (isSell)       { (sells[sym] = sells[sym]||[]).push({...entry, direction:'LONG'});  }
    if (isShortSell)  { (sells[sym] = sells[sym]||[]).push({...entry, direction:'SHORT'}); }
    if (isShortCover) { (buys[sym]  = buys[sym] ||[]).push({...entry, direction:'SHORT'}); }
  });
  return matchLegs(buys, sells);
}

function parseRobinhood(rows) {
  const buys = {}, sells = {};
  rows.forEach(r => {
    const sym   = (r['symbol'] || r['ticker symbol'] || '').trim().toUpperCase();
    if (!sym || sym.length > 6 || !sym.match(/^[A-Z]/)) return;
    const side  = (r['side'] || '').toLowerCase();
    const qty   = Math.abs(cleanNum(r['quantity'] || r['order quantity']));
    const price = Math.abs(cleanNum(r['average price'] || r['price']));
    const date  = toISO(r['date'] || r['order created at'] || '');
    if (!price || !qty || !date) return;
    const entry = { sym, qty, price, date, direction:'LONG' };
    if (side === 'buy')  { (buys[sym]  = buys[sym] ||[]).push(entry); }
    if (side === 'sell') { (sells[sym] = sells[sym]||[]).push(entry); }
  });
  return matchLegs(buys, sells);
}

function matchLegs(buys, sells) {
  const trades = [], allSyms = new Set([...Object.keys(buys), ...Object.keys(sells)]);
  allSyms.forEach(sym => {
    const buyList  = (buys[sym] ||[]).slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
    const sellList = (sells[sym]||[]).slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
    const usedSells = new Array(sellList.length).fill(false);
    const usedBuys  = new Array(buyList.length).fill(false);

    // FIFO match buy legs to sell legs
    buyList.forEach((buy, bi) => {
      const matchIdx = sellList.findIndex((sell,i) => !usedSells[i] && new Date(sell.date) >= new Date(buy.date));
      if (matchIdx !== -1) {
        usedSells[matchIdx] = true;
        usedBuys[bi] = true;
        const sell = sellList[matchIdx], isLong = buy.direction === 'LONG';
        trades.push({ ticker:sym, direction:isLong?'LONG':'SHORT', entry_price:isLong?buy.price:sell.price, exit_price:isLong?sell.price:buy.price, quantity:Math.min(buy.qty,sell.qty), entry_date:isLong?buy.date:sell.date, exit_date:isLong?sell.date:buy.date, status:'CLOSED', setup:'Imported', emotion:'Neutral', notes:'', tags:[], imported:true });
      }
    });

    // Unmatched buys = open LONG positions
    buyList.forEach((buy, bi) => {
      if (!usedBuys[bi]) trades.push({ ticker:sym, direction:'LONG', entry_price:buy.price, exit_price:null, quantity:buy.qty, entry_date:buy.date, exit_date:null, status:'OPEN', setup:'Imported', emotion:'Neutral', notes:'', tags:[], imported:true });
    });

    // Unmatched sells = open SHORT positions (short-sold but not yet covered)
    sellList.forEach((sell, si) => {
      if (!usedSells[si]) trades.push({ ticker:sym, direction:'SHORT', entry_price:sell.price, exit_price:null, quantity:sell.qty, entry_date:sell.date, exit_date:null, status:'OPEN', setup:'Imported', emotion:'Neutral', notes:'', tags:[], imported:true });
    });
  });
  return trades;
}

const pnl  = t => t.status==='OPEN'?null:(t.direction==='LONG'?(t.exit_price-t.entry_price)*t.quantity:(t.entry_price-t.exit_price)*t.quantity);
const pct  = t => { const p=pnl(t); return p==null?null:(p/(t.entry_price*t.quantity))*100; };
const f2   = n => n?.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})??"—";
const fmtM = n => n==null?"—":`${n>=0?"+":"-"}$${Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtP = n => n==null?"—":`${n>=0?"+":""}${n.toFixed(2)}%`;

const T = { bg:'#0b0f1a',panel:'#131720',border:'#1e2535',sub:'#0e1420',text:'#e2e8f0',muted:'#5a6478',dim:'#3d4f6b',green:'#34d399',red:'#f87171',blue:'#60a5fa',purple:'#818cf8' };
const LS = { display:'block',fontSize:11,color:T.muted,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:6 };
const IS = { width:'100%',background:T.sub,border:'1px solid #2d3748',borderRadius:8,color:T.text,fontSize:13,padding:'10px 14px',outline:'none',fontFamily:'inherit',boxSizing:'border-box' };
const BtnPrimary = { background:'linear-gradient(135deg,#6366f1,#8b5cf6)',border:'none',borderRadius:8,color:'#fff',fontSize:13,fontWeight:600,padding:'10px 24px',cursor:'pointer' };
const BtnGhost   = { background:'none',border:'1px solid #2d3748',borderRadius:8,color:T.muted,fontSize:13,fontWeight:600,padding:'10px 20px',cursor:'pointer' };

function Badge({ children, type }) {
  const S = { LONG:{bg:'rgba(52,211,153,0.12)',fg:'#34d399',bd:'rgba(52,211,153,0.2)'}, SHORT:{bg:'rgba(248,113,113,0.12)',fg:'#f87171',bd:'rgba(248,113,113,0.2)'}, OPEN:{bg:'rgba(96,165,250,0.12)',fg:'#60a5fa',bd:'rgba(96,165,250,0.2)'}, CLOSED:{bg:'rgba(100,116,139,0.12)',fg:'#64748b',bd:'rgba(100,116,139,0.2)'} };
  const s=S[type]||{bg:'#1e2535',fg:'#94a3b8',bd:'#2d3748'};
  return <span style={{background:s.bg,color:s.fg,border:`1px solid ${s.bd}`,fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:5,letterSpacing:'0.07em',textTransform:'uppercase'}}>{children}</span>;
}
function StatCard({ label, value, sub, color, icon }) {
  return (
    <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:'20px 24px',flex:1,minWidth:140}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div>
          <div style={{fontSize:11,color:T.muted,letterSpacing:'0.08em',textTransform:'uppercase',marginBottom:8,fontWeight:600}}>{label}</div>
          <div style={{fontSize:26,fontWeight:700,color:color||T.text,letterSpacing:'-0.02em'}}>{value}</div>
          {sub&&<div style={{fontSize:12,color:T.muted,marginTop:4}}>{sub}</div>}
        </div>
        {icon&&<div style={{fontSize:20,opacity:0.4}}>{icon}</div>}
      </div>
    </div>
  );
}
function NavItem({ icon, label, active, onClick, badge }) {
  return (
    <button onClick={onClick} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'10px 12px',borderRadius:8,border:'none',cursor:'pointer',background:active?'rgba(99,102,241,0.15)':'transparent',color:active?T.purple:T.muted,transition:'all .15s',textAlign:'left',position:'relative'}}>
      <span style={{fontSize:16}}>{icon}</span>
      <span style={{fontSize:13,fontWeight:active?600:500}}>{label}</span>
      {badge&&<span style={{marginLeft:'auto',background:'#ef4444',color:'#fff',fontSize:10,fontWeight:700,padding:'2px 6px',borderRadius:10}}>{badge}</span>}
      {active&&<div style={{position:'absolute',left:0,top:'20%',bottom:'20%',width:3,background:T.purple,borderRadius:'0 3px 3px 0'}}/>}
    </button>
  );
}
function EquityCurve({ trades }) {
  const closed=[...trades].filter(t=>t.status==='CLOSED').sort((a,b)=>new Date(a.exit_date)-new Date(b.exit_date));
  if(closed.length<2) return <div style={{color:T.muted,fontSize:12,textAlign:'center',padding:40}}>Need 2+ closed trades</div>;
  let cum=0;
  const pts=closed.map(t=>{cum+=(pnl(t)||0);return cum;});
  const mn=Math.min(0,...pts),mx=Math.max(...pts),range=mx-mn||1;
  const W=600,H=140,P=10;
  const x=i=>P+(i/(pts.length-1))*(W-P*2), y=v=>H-P-((v-mn)/range)*(H-P*2);
  const pathD=pts.map((v,i)=>`${i===0?'M':'L'}${x(i)},${y(v)}`).join(' ');
  const col=pts[pts.length-1]>=0?T.green:T.red;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{display:'block'}}>
      <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.25"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs>
      <line x1={P} y1={y(0)} x2={W-P} y2={y(0)} stroke="#2d3748" strokeWidth="1" strokeDasharray="4 4"/>
      <path d={`${pathD} L${x(pts.length-1)},${H} L${x(0)},${H} Z`} fill="url(#eg)"/>
      <path d={pathD} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      {pts.map((v,i)=><circle key={i} cx={x(i)} cy={y(v)} r="3" fill={col} opacity="0.8"/>)}
    </svg>
  );
}
function PnLCalendar({ trades }) {
  const [month,setMonth]=useState(new Date());
  const yr=month.getFullYear(), mo=month.getMonth(), dayMap={};
  trades.filter(t=>t.status==='CLOSED'&&t.exit_date).forEach(t=>{
    const d=new Date(t.exit_date);
    if(d.getFullYear()===yr&&d.getMonth()===mo){const k=d.getDate();dayMap[k]=(dayMap[k]||0)+(pnl(t)||0);}
  });
  const firstDay=new Date(yr,mo,1).getDay(), days=new Date(yr,mo+1,0).getDate();
  const cells=[]; for(let i=0;i<firstDay;i++)cells.push(null); for(let d=1;d<=days;d++)cells.push(d);
  const maxAbs=Math.max(...Object.values(dayMap).map(Math.abs),1);
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <button onClick={()=>setMonth(m=>new Date(m.getFullYear(),m.getMonth()-1,1))} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:18,padding:'2px 8px'}}>&#8249;</button>
        <span style={{fontSize:13,fontWeight:600,color:T.text}}>{month.toLocaleString('default',{month:'long',year:'numeric'})}</span>
        <button onClick={()=>setMonth(m=>new Date(m.getFullYear(),m.getMonth()+1,1))} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:18,padding:'2px 8px'}}>&#8250;</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:4}}>
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=><div key={d} style={{textAlign:'center',fontSize:10,color:T.dim,padding:'4px 0',fontWeight:600}}>{d}</div>)}
        {cells.map((d,i)=>{
          if(!d) return <div key={`e${i}`}/>;
          const v=dayMap[d], intensity=v?Math.min(Math.abs(v)/maxAbs,1):0;
          const bg=v==null?'#1a2030':v>0?`rgba(52,211,153,${0.1+intensity*0.5})`:`rgba(248,113,113,${0.1+intensity*0.5})`;
          return <div key={d} style={{background:bg,borderRadius:6,aspectRatio:'1',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontSize:10,color:v?(v>0?T.green:T.red):'#475569',border:'1px solid rgba(255,255,255,0.04)'}}>
            <div style={{fontWeight:600}}>{d}</div>
            {v&&<div style={{fontSize:9,marginTop:1}}>{v>0?'+':'−'}${Math.round(Math.abs(v))}</div>}
          </div>;
        })}
      </div>
    </div>
  );
}

function TradeModal({ trade, onSave, onDelete, onClose, saving }) {
  const isEdit=!!trade?.id;
  const blank={ticker:'',direction:'LONG',entry_price:'',exit_price:'',quantity:'',entry_date:new Date().toISOString().slice(0,10),exit_date:'',status:'OPEN',setup:'Breakout',emotion:'Neutral',notes:'',tags:[]};
  const [form,setForm]=useState(trade?{...trade,entry_price:trade.entry_price??'',exit_price:trade.exit_price??'',exit_date:trade.exit_date??''}:blank);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const toggleTag=tag=>set('tags',(form.tags||[]).includes(tag)?(form.tags||[]).filter(t=>t!==tag):[...(form.tags||[]),tag]);
  const estPnl=form.entry_price&&form.exit_price&&form.quantity?((form.direction==='LONG'?parseFloat(form.exit_price)-parseFloat(form.entry_price):parseFloat(form.entry_price)-parseFloat(form.exit_price))*parseInt(form.quantity)):null;
  const save=()=>{
    if(!form.ticker||!form.entry_price||!form.quantity||!form.entry_date) return;
    onSave({...form,ticker:form.ticker.toUpperCase(),entry_price:parseFloat(form.entry_price),exit_price:form.exit_price?parseFloat(form.exit_price):null,quantity:parseInt(form.quantity),exit_date:form.exit_date||null,status:form.exit_price?'CLOSED':'OPEN'});
  };
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(6px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:16,width:'100%',maxWidth:560,maxHeight:'90vh',overflowY:'auto',padding:32}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:28}}>
          <div><h2 style={{margin:0,fontSize:18,fontWeight:700,color:T.text}}>{isEdit?'Edit Trade':'Log New Trade'}</h2><p style={{margin:'4px 0 0',fontSize:12,color:T.muted}}>{isEdit?'Update trade details':'Record your trade details'}</p></div>
          <button onClick={onClose} style={{background:'none',border:'none',color:T.muted,fontSize:20,cursor:'pointer'}}>&#x2715;</button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16,marginBottom:16}}>
          <div><label style={LS}>Ticker *</label><input style={IS} placeholder="AAPL" value={form.ticker} onChange={e=>set('ticker',e.target.value.toUpperCase())}/></div>
          <div><label style={LS}>Direction</label><div style={{display:'flex',gap:8,marginTop:6}}>{['LONG','SHORT'].map(d=><button key={d} onClick={()=>set('direction',d)} style={{flex:1,padding:'9px 0',border:'1px solid',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700,transition:'all .15s',borderColor:form.direction===d?(d==='LONG'?T.green:T.red):'#2d3748',background:form.direction===d?(d==='LONG'?'rgba(52,211,153,0.15)':'rgba(248,113,113,0.15)'):'#1a2030',color:form.direction===d?(d==='LONG'?T.green:T.red):T.muted}}>{d}</button>)}</div></div>
          <div><label style={LS}>Qty *</label><input style={IS} type="number" placeholder="100" value={form.quantity} onChange={e=>set('quantity',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
          <div><label style={LS}>Entry Price *</label><input style={IS} type="number" step="0.01" placeholder="0.00" value={form.entry_price} onChange={e=>set('entry_price',e.target.value)}/></div>
          <div><label style={LS}>Exit Price</label><input style={IS} type="number" step="0.01" placeholder="Blank = open" value={form.exit_price} onChange={e=>set('exit_price',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
          <div><label style={LS}>Entry Date *</label><input style={IS} type="date" value={form.entry_date} onChange={e=>set('entry_date',e.target.value)}/></div>
          <div><label style={LS}>Exit Date</label><input style={IS} type="date" value={form.exit_date} onChange={e=>set('exit_date',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
          <div><label style={LS}>Setup</label><select style={{...IS,cursor:'pointer'}} value={form.setup} onChange={e=>set('setup',e.target.value)}>{SETUPS.map(s=><option key={s}>{s}</option>)}</select></div>
          <div><label style={LS}>Emotion</label><select style={{...IS,cursor:'pointer'}} value={form.emotion} onChange={e=>set('emotion',e.target.value)}>{EMOTIONS.map(e=><option key={e}>{e}</option>)}</select></div>
        </div>
        <div style={{marginBottom:16}}><label style={LS}>Notes</label><textarea style={{...IS,resize:'vertical',minHeight:80}} placeholder="Setup rationale, observations, lessons..." value={form.notes} onChange={e=>set('notes',e.target.value)}/></div>
        <div style={{marginBottom:24}}><label style={LS}>Tags</label><div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:6}}>{ALL_TAGS.map(tag=><button key={tag} onClick={()=>toggleTag(tag)} style={{padding:'5px 12px',borderRadius:20,border:'1px solid',cursor:'pointer',fontSize:11,fontWeight:600,transition:'all .15s',background:(form.tags||[]).includes(tag)?'rgba(99,102,241,0.2)':'#1a2030',borderColor:(form.tags||[]).includes(tag)?'#6366f1':'#2d3748',color:(form.tags||[]).includes(tag)?T.purple:T.muted}}>{tag}</button>)}</div></div>
        {estPnl!==null&&<div style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:10,padding:'14px 18px',marginBottom:20,display:'flex',justifyContent:'space-between',alignItems:'center'}}><span style={{fontSize:12,color:T.muted,fontWeight:600}}>Estimated P&L</span><span style={{fontSize:20,fontWeight:700,color:estPnl>=0?T.green:T.red}}>{fmtM(estPnl)}</span></div>}
        <div style={{display:'flex',gap:10,justifyContent:'space-between'}}>
          {isEdit?<button onClick={()=>onDelete(form.id)} style={{...BtnGhost,color:T.red,borderColor:'rgba(248,113,113,0.3)'}}>Delete</button>:<div/>}
          <div style={{display:'flex',gap:10}}><button onClick={onClose} style={BtnGhost}>Cancel</button><button onClick={save} style={{...BtnPrimary,opacity:saving?0.7:1}} disabled={saving}>{saving?'Saving...':'Save Trade'}</button></div>
        </div>
      </div>
    </div>
  );
}

function CSVImportModal({ existingTrades, onImport, onClose }) {
  const [step,setStep]=useState('upload'),[broker,setBroker]=useState(null),[parsedTrades,setParsed]=useState([]),[selected,setSelected]=useState(new Set()),[error,setError]=useState(''),[dragging,setDragging]=useState(false),[activeTab,setActiveTab]=useState('upload'),[pasteText,setPasteText]=useState(''),[importing,setImporting]=useState(false);
  const fileRef=useRef();
  const processText=useCallback((text)=>{setError('');try{const {headers,rows}=parseCSV(text);const detected=detectBroker(headers);if(detected==='unknown'){setError('Could not detect broker. Expected Fidelity or Robinhood CSV headers.');return;}let trades=detected==='fidelity'?parseFidelity(rows):parseRobinhood(rows);if(trades.length===0){setError('No valid trades found. Make sure your CSV contains buy/sell transactions.');return;}const existingKeys=new Set(existingTrades.map(t=>`${t.ticker}-${t.entry_date}-${t.entry_price}`));trades=trades.map(t=>({...t,duplicate:existingKeys.has(`${t.ticker}-${t.entry_date}-${t.entry_price}`)}));setBroker(detected);setParsed(trades);setSelected(new Set(trades.map((_,i)=>i).filter(i=>!trades[i].duplicate)));setStep('preview');}catch(e){setError('Parse error: '+e.message);}},[existingTrades]);
  const handleFile=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>processText(ev.target.result);r.readAsText(f);};
  const handleDrop=useCallback(e=>{e.preventDefault();setDragging(false);const f=e.dataTransfer.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>processText(ev.target.result);r.readAsText(f);},[processText]);
  const toggleRow=i=>setSelected(s=>{const n=new Set(s);n.has(i)?n.delete(i):n.add(i);return n;});
  const toggleAll=()=>{const elig=parsedTrades.map((_,i)=>i).filter(i=>!parsedTrades[i].duplicate);setSelected(s=>s.size===elig.length?new Set():new Set(elig));};
  const doImport=async()=>{setImporting(true);await onImport(parsedTrades.filter((_,i)=>selected.has(i)).map(({duplicate,...t})=>t));setImporting(false);setStep('done');};
  const newCount=parsedTrades.filter(t=>!t.duplicate).length,dupCount=parsedTrades.filter(t=>t.duplicate).length;
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.82)',backdropFilter:'blur(8px)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:20,width:'100%',maxWidth:720,maxHeight:'93vh',overflowY:'auto',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'28px 32px 20px',borderBottom:`1px solid ${T.border}`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:20}}>
            <div><h2 style={{margin:0,fontSize:20,fontWeight:700,color:T.text}}>Import Trades from CSV</h2><p style={{margin:'5px 0 0',fontSize:13,color:T.muted}}>Supports Fidelity and Robinhood · Saved to your account</p></div>
            <button onClick={onClose} style={{background:'none',border:'none',color:T.muted,fontSize:22,cursor:'pointer'}}>&#x2715;</button>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            {[['Upload','upload'],['Preview','preview'],['Done','done']].map(([label,id],i)=>{const active=step===id,past={'upload':0,'preview':1,'done':2}[step]>{'upload':0,'preview':1,'done':2}[id];return<div key={id} style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:26,height:26,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,background:active||past?'linear-gradient(135deg,#6366f1,#8b5cf6)':T.sub,color:active||past?'#fff':T.muted}}>{past?'✓':i+1}</div><span style={{fontSize:12,fontWeight:600,color:active?T.text:T.muted}}>{label}</span>{i<2&&<div style={{width:28,height:1,background:T.border}}/>}</div>;})}
          </div>
        </div>
        <div style={{padding:32,flex:1}}>
          {step==='upload'&&<>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:24}}>
              {[{id:'fidelity',name:'Fidelity',icon:'🏦',steps:['Accounts & Trade → Activity & Orders → History','Select date range → Download CSV'],headers:'Run Date, Account Number, Action, Symbol, Price ($), Quantity...'},{id:'robinhood',name:'Robinhood',icon:'🟢',steps:['Account → Statements & History → History','Select date range → Export CSV'],headers:'symbol, date, side, quantity, average price...'}].map(b=>(
                <div key={b.id} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}><span style={{fontSize:22}}>{b.icon}</span><div style={{fontSize:14,fontWeight:700,color:T.text}}>{b.name}</div></div>
                  <ol style={{paddingLeft:16,margin:0}}>{b.steps.map((s,i)=><li key={i} style={{fontSize:11,color:T.muted,marginBottom:4,lineHeight:1.5}}>{s}</li>)}</ol>
                  <div style={{marginTop:10,padding:'8px 10px',background:T.panel,borderRadius:6,border:`1px solid ${T.border}`}}><code style={{fontSize:10,color:T.purple}}>{b.headers}</code></div>
                </div>
              ))}
            </div>
            <div style={{display:'flex',gap:2,background:T.sub,borderRadius:10,padding:4,marginBottom:20,width:'fit-content'}}>
              {[['upload','📁 Upload'],['paste','📋 Paste'],['sample','🧪 Sample']].map(([id,label])=>(<button key={id} onClick={()=>setActiveTab(id)} style={{padding:'8px 16px',border:'none',borderRadius:7,cursor:'pointer',fontSize:12,fontWeight:600,background:activeTab===id?T.panel:'transparent',color:activeTab===id?T.text:T.muted}}>{label}</button>))}
            </div>
            {activeTab==='upload'&&(
              <div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={handleDrop} style={{border:`2px dashed ${dragging?'#6366f1':T.border}`,borderRadius:14,padding:'48px 24px',textAlign:'center',background:dragging?'rgba(99,102,241,0.06)':T.sub,cursor:'pointer'}} onClick={()=>fileRef.current.click()}>
                <input ref={fileRef} type="file" accept=".csv,.txt" style={{display:'none'}} onChange={handleFile}/>
                <div style={{fontSize:40,marginBottom:12}}>📂</div>
                <div style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:6}}>Drop your CSV here</div>
                <div style={{fontSize:12,color:T.muted,marginBottom:18}}>or click to browse</div>
                <button style={BtnPrimary} onClick={e=>{e.stopPropagation();fileRef.current.click();}}>Choose File</button>
              </div>
            )}
            {activeTab==='paste'&&(
              <div>
                <textarea value={pasteText} onChange={e=>setPasteText(e.target.value)} placeholder="Paste your CSV content here..." style={{...IS,minHeight:200,resize:'vertical',fontFamily:'monospace',fontSize:11}}/>
                <div style={{display:'flex',justifyContent:'flex-end',marginTop:12,gap:10}}>
                  <button onClick={()=>setPasteText('')} style={BtnGhost}>Clear</button>
                  <button onClick={()=>processText(pasteText)} style={BtnPrimary} disabled={!pasteText.trim()}>Parse →</button>
                </div>
              </div>
            )}
            {activeTab==='sample'&&(
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
                {[{label:'🏦 Fidelity',data:FIDELITY_SAMPLE},{label:'🟢 Robinhood',data:ROBINHOOD_SAMPLE}].map(s=>(
                  <div key={s.label} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:12,padding:18}}>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:8}}>{s.label}</div>
                    <pre style={{fontSize:10,color:T.dim,overflowX:'auto',marginBottom:14,lineHeight:1.6,background:T.panel,padding:'8px 10px',borderRadius:6}}>{s.data.split('\n').slice(0,3).join('\n')}...</pre>
                    <button style={{...BtnPrimary,width:'100%',fontSize:12}} onClick={()=>processText(s.data)}>Load Sample →</button>
                  </div>
                ))}
              </div>
            )}
            {error&&<div style={{marginTop:16,padding:'12px 16px',background:'rgba(248,113,113,0.1)',border:'1px solid rgba(248,113,113,0.3)',borderRadius:8,color:T.red,fontSize:13}}>⚠️ {error}</div>}
          </>}
          {step==='preview'&&<>
            <div style={{display:'flex',gap:12,marginBottom:20,flexWrap:'wrap'}}>
              {[{label:'Broker',value:broker==='fidelity'?'🏦 Fidelity':'🟢 Robinhood',color:T.purple},{label:'Total',value:parsedTrades.length},{label:'New',value:newCount,color:T.green},{label:'Duplicates',value:dupCount,color:T.muted},{label:'Selected',value:selected.size,color:T.blue}].map(s=>(
                <div key={s.label} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 16px',flex:1,minWidth:90}}>
                  <div style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:'uppercase',marginBottom:4}}>{s.label}</div>
                  <div style={{fontSize:20,fontWeight:700,color:s.color||T.text}}>{s.value}</div>
                </div>
              ))}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{fontSize:12,color:T.muted}}>{selected.size} of {newCount} selected</div>
              <button onClick={toggleAll} style={{...BtnGhost,fontSize:11,padding:'6px 14px'}}>{selected.size===newCount?'Deselect All':'Select All'}</button>
            </div>
            <div style={{border:`1px solid ${T.border}`,borderRadius:12,overflow:'hidden',marginBottom:18}}>
              <div style={{display:'grid',gridTemplateColumns:'36px 80px 54px 88px 88px 60px 108px 108px 78px',padding:'10px 16px',background:T.sub,borderBottom:`1px solid ${T.border}`}}>
                <div/>{['Ticker','Dir','Entry $','Exit $','Qty','Entry Date','Exit Date','Status'].map(h=><div key={h} style={{fontSize:10,color:T.dim,fontWeight:700,letterSpacing:'0.07em',textTransform:'uppercase'}}>{h}</div>)}
              </div>
              <div style={{maxHeight:320,overflowY:'auto'}}>
                {parsedTrades.map((t,i)=>(
                  <div key={i} onClick={()=>!t.duplicate&&toggleRow(i)} style={{display:'grid',gridTemplateColumns:'36px 80px 54px 88px 88px 60px 108px 108px 78px',padding:'11px 16px',borderBottom:'1px solid #111827',alignItems:'center',cursor:t.duplicate?'default':'pointer',background:selected.has(i)?'rgba(99,102,241,0.07)':t.duplicate?'rgba(0,0,0,0.3)':T.panel,opacity:t.duplicate?0.45:1}}>
                    <input type="checkbox" checked={selected.has(i)} disabled={t.duplicate} onChange={()=>toggleRow(i)} style={{accentColor:'#6366f1',width:14,height:14}} onClick={e=>e.stopPropagation()}/>
                    <div style={{display:'flex',alignItems:'center',gap:5}}><span style={{fontSize:13,fontWeight:700,color:T.text}}>{t.ticker}</span>{t.duplicate&&<span style={{fontSize:9,color:T.muted,background:'#1a2030',padding:'1px 5px',borderRadius:3}}>DUP</span>}</div>
                    <Badge type={t.direction}>{t.direction==='LONG'?'L':'S'}</Badge>
                    <div style={{fontSize:12,color:'#94a3b8'}}>${f2(t.entry_price)}</div>
                    <div style={{fontSize:12,color:'#94a3b8'}}>{t.exit_price?`$${f2(t.exit_price)}`:'—'}</div>
                    <div style={{fontSize:12,color:T.muted}}>{t.quantity}</div>
                    <div style={{fontSize:11,color:T.muted}}>{t.entry_date}</div>
                    <div style={{fontSize:11,color:T.muted}}>{t.exit_date||'—'}</div>
                    <Badge type={t.status}>{t.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
            <div style={{background:'rgba(99,102,241,0.08)',border:'1px solid rgba(99,102,241,0.2)',borderRadius:8,padding:'10px 14px',marginBottom:20,fontSize:12,color:'#a5b4fc'}}>💾 Trades will be saved permanently to your account.</div>
            <div style={{display:'flex',gap:12,justifyContent:'space-between'}}>
              <button onClick={()=>setStep('upload')} style={BtnGhost}>← Back</button>
              <button onClick={doImport} disabled={selected.size===0||importing} style={{...BtnPrimary,opacity:(selected.size===0||importing)?0.5:1}}>{importing?'Saving...':'Import & Save →'}</button>
            </div>
          </>}
          {step==='done'&&(
            <div style={{textAlign:'center',padding:'40px 0'}}>
              <div style={{fontSize:60,marginBottom:16}}>🎉</div>
              <h3 style={{fontSize:22,fontWeight:700,color:T.text,marginBottom:10}}>Import Complete!</h3>
              <p style={{fontSize:14,color:T.muted,marginBottom:32}}>{selected.size} trade{selected.size!==1?'s were':' was'} saved to your account.</p>
              <div style={{display:'flex',gap:12,justifyContent:'center'}}>
                <button onClick={()=>{setStep('upload');setParsed([]);setSelected(new Set());setBroker(null);setError('');setPasteText('');}} style={BtnGhost}>Import More</button>
                <button onClick={onClose} style={BtnPrimary}>View Journal →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TradingJournal({ session }) {
  const [trades,setTrades]       = useState([]);
  const [loading,setLoading]     = useState(true);
  const [saving,setSaving]       = useState(false);
  const [dbError,setDbError]     = useState('');
  const [page,setPage]           = useState('dashboard');
  const [showTrade,setShowTrade] = useState(false);
  const [showCSV,setShowCSV]     = useState(false);
  const [editTrade,setEditTrade] = useState(null);
  const [filter,setFilter]       = useState({dir:'ALL',status:'ALL'});
  const [sort,setSort]           = useState('date');
  const [search,setSearch]       = useState('');

  const user = session?.user;

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    supabase.from('trades').select('*').eq('user_id',user.id).order('entry_date',{ascending:false})
      .then(({data,error}) => { if(error) setDbError(error.message); else setTrades(data||[]); setLoading(false); });
  }, [user]);

  const saveTrade = async (trade) => {
    setSaving(true); setDbError('');
    const payload = {...trade, user_id:user.id};
    const id = payload.id; delete payload.id;
    if (id) {
      const {data,error} = await supabase.from('trades').update(payload).eq('id',id).eq('user_id',user.id).select().single();
      if(error) setDbError(error.message); else setTrades(ts=>ts.map(t=>t.id===id?data:t));
    } else {
      const {data,error} = await supabase.from('trades').insert(payload).select().single();
      if(error) setDbError(error.message); else setTrades(ts=>[data,...ts]);
    }
    setSaving(false); setShowTrade(false);
  };
  const deleteTrade = async (id) => {
    const {error} = await supabase.from('trades').delete().eq('id',id).eq('user_id',user.id);
    if(error) setDbError(error.message); else setTrades(ts=>ts.filter(t=>t.id!==id));
    setShowTrade(false);
  };
  const importTrades = async (newTrades) => {
    const payload = newTrades.map(t=>({...t,user_id:user.id}));
    const {data,error} = await supabase.from('trades').insert(payload).select();
    if(error) setDbError(error.message); else setTrades(ts=>[...(data||[]),...ts]);
  };
  const signOut = () => supabase.auth.signOut();

  const closed=trades.filter(t=>t.status==='CLOSED'), totalPnl=closed.reduce((s,t)=>s+(pnl(t)||0),0), winners=closed.filter(t=>(pnl(t)||0)>0), losers=closed.filter(t=>(pnl(t)||0)<0), winRate=closed.length?(winners.length/closed.length*100):0, avgWin=winners.length?winners.reduce((s,t)=>s+(pnl(t)||0),0)/winners.length:0, avgLoss=losers.length?losers.reduce((s,t)=>s+(pnl(t)||0),0)/losers.length:0, profitFactor=Math.abs(avgLoss)>0?Math.abs(avgWin/avgLoss):0, openCount=trades.filter(t=>t.status==='OPEN').length, importedCount=trades.filter(t=>t.imported).length;

  const filtered=useMemo(()=>{let arr=[...trades];if(filter.dir!=='ALL')arr=arr.filter(t=>t.direction===filter.dir);if(filter.status!=='ALL')arr=arr.filter(t=>t.status===filter.status);if(search)arr=arr.filter(t=>t.ticker?.includes(search.toUpperCase())||t.notes?.toLowerCase().includes(search.toLowerCase()));if(sort==='date')arr.sort((a,b)=>new Date(b.entry_date)-new Date(a.entry_date));if(sort==='pnl')arr.sort((a,b)=>(pnl(b)||0)-(pnl(a)||0));if(sort==='ticker')arr.sort((a,b)=>(a.ticker||'').localeCompare(b.ticker||''));return arr;},[trades,filter,sort,search]);

  const setupPnl={},emotionPnl={};
  closed.forEach(t=>{setupPnl[t.setup]=(setupPnl[t.setup]||0)+(pnl(t)||0);emotionPnl[t.emotion]=(emotionPnl[t.emotion]||0)+(pnl(t)||0);});

  const PAGES={dashboard:'Dashboard',log:'Trade Log',analytics:'Analytics',psychology:'Psychology',calendar:'P&L Calendar',sync:'Import Trades'};
  const SUBS={dashboard:'Trading overview at a glance',log:'All trades in one place',analytics:'Deep performance analysis',psychology:'Mind & emotion tracking',calendar:'Daily P&L heatmap',sync:'Import from Fidelity or Robinhood'};

  return (
    <div style={{display:'flex',height:'100vh',background:T.bg,fontFamily:"'Inter',system-ui,sans-serif",color:T.text,overflow:'hidden'}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${T.bg}}::-webkit-scrollbar-thumb{background:#1e2535;border-radius:3px}input,select,textarea{font-family:inherit}input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.4)}.tr:hover{background:#131720!important}.tr{cursor:pointer;transition:background .1s}.nb:hover{background:rgba(99,102,241,0.08)!important;color:#94a3b8!important}@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.fu{animation:fu .22s ease}.so-btn:hover{background:rgba(248,113,113,0.1)!important;color:#f87171!important;border-color:rgba(248,113,113,0.4)!important}`}</style>

      <aside style={{width:220,background:T.sub,borderRight:`1px solid ${T.border}`,display:'flex',flexDirection:'column',flexShrink:0,padding:'0 12px'}}>
        <div style={{padding:'22px 8px 20px',borderBottom:`1px solid ${T.border}`}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:32,height:32,background:'linear-gradient(135deg,#6366f1,#8b5cf6)',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>📈</div>
            <div><div style={{fontSize:14,fontWeight:800,letterSpacing:'-0.02em',color:T.text}}>TradeLog</div><div style={{fontSize:10,color:T.dim}}>Pro Journal</div></div>
          </div>
        </div>
        <nav style={{flex:1,padding:'16px 0',display:'flex',flexDirection:'column',gap:2}}>
          <div style={{fontSize:10,color:T.dim,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',padding:'8px 12px 4px'}}>Overview</div>
          <NavItem icon="▦"  label="Dashboard"  active={page==='dashboard'} onClick={()=>setPage('dashboard')}/>
          <NavItem icon="📅" label="Calendar"   active={page==='calendar'}  onClick={()=>setPage('calendar')}/>
          <div style={{fontSize:10,color:T.dim,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',padding:'12px 12px 4px'}}>Trading</div>
          <NavItem icon="📒" label="Trade Log"  active={page==='log'}       onClick={()=>setPage('log')} badge={openCount||null}/>
          <NavItem icon="📊" label="Analytics"  active={page==='analytics'} onClick={()=>setPage('analytics')}/>
          <NavItem icon="🧠" label="Psychology" active={page==='psychology'} onClick={()=>setPage('psychology')}/>
          <div style={{fontSize:10,color:T.dim,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',padding:'12px 12px 4px'}}>Import</div>
          <NavItem icon="📁" label="Import CSV" active={page==='sync'}      onClick={()=>setPage('sync')} badge={importedCount||null}/>
        </nav>
        <div style={{padding:'12px 8px 16px',borderTop:`1px solid ${T.border}`}}>
          <div style={{background:T.panel,borderRadius:10,padding:12}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
              <div style={{width:30,height:30,borderRadius:'50%',background:'linear-gradient(135deg,#6366f1,#06b6d4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,flexShrink:0,color:'#fff'}}>{(user?.email?.[0]||'U').toUpperCase()}</div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:11,fontWeight:600,color:T.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:130}}>{user?.email}</div>
                <div style={{fontSize:10,color:T.dim}}>{trades.length} trades</div>
              </div>
            </div>
            <button className="so-btn" onClick={signOut} style={{width:'100%',background:'none',border:`1px solid ${T.border}`,borderRadius:7,color:T.muted,fontSize:11,fontWeight:600,padding:'7px 0',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:6,transition:'all .15s'}}>Sign Out</button>
          </div>
        </div>
      </aside>

      <main style={{flex:1,overflow:'auto',display:'flex',flexDirection:'column'}}>
        <div style={{background:T.sub,borderBottom:`1px solid ${T.border}`,padding:'14px 28px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div><h1 style={{fontSize:18,fontWeight:700,color:T.text,letterSpacing:'-0.02em'}}>{PAGES[page]}</h1><p style={{fontSize:12,color:T.muted,marginTop:2}}>{SUBS[page]}</p></div>
          <div style={{display:'flex',gap:10}}>
            <button onClick={()=>setShowCSV(true)} style={{...BtnGhost,display:'flex',alignItems:'center',gap:6,fontSize:12,padding:'9px 16px'}}>📁 Import CSV</button>
            <button onClick={()=>{setEditTrade(null);setShowTrade(true);}} style={{...BtnPrimary,display:'flex',alignItems:'center',gap:6,padding:'9px 18px'}}>+ Log Trade</button>
          </div>
        </div>

        {dbError&&<div style={{background:'rgba(248,113,113,0.1)',border:'1px solid rgba(248,113,113,0.3)',padding:'10px 28px',fontSize:12,color:T.red,display:'flex',justifyContent:'space-between',alignItems:'center'}}>⚠️ {dbError}<button onClick={()=>setDbError('')} style={{background:'none',border:'none',color:T.red,cursor:'pointer',fontSize:16}}>✕</button></div>}

        <div style={{flex:1,padding:28,overflow:'auto'}} className="fu" key={page}>
          {loading&&<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300}}><div style={{textAlign:'center'}}><div style={{fontSize:32,marginBottom:12}}>⏳</div><div style={{color:T.muted,fontSize:13}}>Loading your trades...</div></div></div>}

          {!loading&&trades.length===0&&page==='dashboard'&&(
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:300}}>
              <div style={{textAlign:'center',maxWidth:360}}>
                <div style={{fontSize:48,marginBottom:16}}>📒</div>
                <h3 style={{fontSize:18,fontWeight:700,color:T.text,marginBottom:8}}>No trades yet</h3>
                <p style={{fontSize:13,color:T.muted,marginBottom:24,lineHeight:1.6}}>Log your first trade manually or import from Fidelity or Robinhood CSV.</p>
                <div style={{display:'flex',gap:10,justifyContent:'center'}}>
                  <button onClick={()=>setShowCSV(true)} style={BtnGhost}>📁 Import CSV</button>
                  <button onClick={()=>{setEditTrade(null);setShowTrade(true);}} style={BtnPrimary}>+ Log Trade</button>
                </div>
              </div>
            </div>
          )}

          {!loading&&trades.length>0&&page==='dashboard'&&<>
            <div style={{display:'flex',gap:14,marginBottom:20,flexWrap:'wrap'}}>
              <StatCard label="Total P&L" value={fmtM(totalPnl)} color={totalPnl>=0?T.green:T.red} icon="💰"/>
              <StatCard label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${winners.length}W / ${losers.length}L`} icon="🎯"/>
              <StatCard label="Profit Factor" value={profitFactor.toFixed(2)} sub="Gross profit/loss" icon="⚡"/>
              <StatCard label="Avg Winner" value={fmtM(avgWin)} color={T.green} icon="↑"/>
              <StatCard label="Avg Loser" value={fmtM(avgLoss)} color={T.red} icon="↓"/>
              <StatCard label="Open" value={openCount} color={T.blue} icon="🔓"/>
            </div>
            {importedCount>0&&<div style={{background:'rgba(99,102,241,0.08)',border:'1px solid rgba(99,102,241,0.2)',borderRadius:10,padding:'12px 18px',marginBottom:18,display:'flex',justifyContent:'space-between',alignItems:'center'}}><span style={{fontSize:13,color:'#a5b4fc'}}>✅ {importedCount} trades imported from CSV</span><button onClick={()=>setPage('log')} style={{...BtnGhost,fontSize:11,padding:'5px 12px',color:T.purple,borderColor:'rgba(99,102,241,0.3)'}}>View All →</button></div>}
            <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:16,marginBottom:16}}>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                  <div><div style={{fontSize:13,fontWeight:600,color:T.text}}>Equity Curve</div><div style={{fontSize:11,color:T.muted}}>Cumulative P&L</div></div>
                  <span style={{fontSize:18,fontWeight:700,color:totalPnl>=0?T.green:T.red}}>{fmtM(totalPnl)}</span>
                </div>
                <EquityCurve trades={trades}/>
              </div>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:16}}>Recent Trades</div>
                {[...trades].sort((a,b)=>new Date(b.entry_date)-new Date(a.entry_date)).slice(0,5).map(t=>{const p=pnl(t);return(
                  <div key={t.id} onClick={()=>{setEditTrade(t);setShowTrade(true);}} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 0',borderBottom:'1px solid #1a2030',cursor:'pointer'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <div style={{width:34,height:34,borderRadius:8,background:t.direction==='LONG'?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:t.direction==='LONG'?T.green:T.red}}>{(t.ticker||'').slice(0,4)}</div>
                      <div><div style={{fontSize:13,fontWeight:600,color:T.text}}>{t.ticker}</div><div style={{fontSize:11,color:T.muted}}>{t.setup} · {t.entry_date}</div></div>
                    </div>
                    <div>{p!=null?<div style={{fontSize:13,fontWeight:700,color:p>=0?T.green:T.red}}>{fmtM(p)}</div>:<Badge type="OPEN">OPEN</Badge>}</div>
                  </div>
                );})}
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
              {[['P&L by Setup',setupPnl],['P&L by Emotion',emotionPnl]].map(([title,data])=>(
                <div key={title} style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:16}}>{title}</div>
                  {Object.entries(data).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{const mx=Math.max(...Object.values(data).map(Math.abs));return(
                    <div key={k} style={{marginBottom:12}}>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:5}}><span style={{color:'#94a3b8'}}>{k}</span><span style={{fontWeight:600,color:v>=0?T.green:T.red}}>{fmtM(v)}</span></div>
                      <div style={{height:5,background:'#1a2030',borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.abs(v)/mx*100}%`,background:v>=0?T.green:T.red,borderRadius:3}}/></div>
                    </div>
                  );})}
                </div>
              ))}
            </div>
          </>}

          {!loading&&page==='log'&&<>
            <div style={{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap',alignItems:'center'}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍  Search ticker or notes..." style={{...IS,width:220,fontSize:12}}/>
              {['ALL','LONG','SHORT'].map(d=><button key={d} className="nb" onClick={()=>setFilter(f=>({...f,dir:d}))} style={{padding:'8px 14px',borderRadius:8,border:'1px solid',cursor:'pointer',fontSize:11,fontWeight:600,borderColor:filter.dir===d?'#6366f1':'#2d3748',background:filter.dir===d?'rgba(99,102,241,0.15)':T.panel,color:filter.dir===d?T.purple:T.muted}}>{d}</button>)}
              {['ALL','OPEN','CLOSED'].map(s=><button key={s} className="nb" onClick={()=>setFilter(f=>({...f,status:s}))} style={{padding:'8px 14px',borderRadius:8,border:'1px solid',cursor:'pointer',fontSize:11,fontWeight:600,borderColor:filter.status===s?'#6366f1':'#2d3748',background:filter.status===s?'rgba(99,102,241,0.15)':T.panel,color:filter.status===s?T.purple:T.muted}}>{s}</button>)}
              <select value={sort} onChange={e=>setSort(e.target.value)} style={{...IS,width:'auto',fontSize:11,padding:'8px 14px',cursor:'pointer'}}>
                <option value="date">Sort: Date ↓</option><option value="pnl">Sort: P&L</option><option value="ticker">Sort: Ticker</option>
              </select>
              <button onClick={()=>setShowCSV(true)} style={{...BtnGhost,fontSize:11,padding:'8px 14px',marginLeft:'auto'}}>📁 Import CSV</button>
            </div>
            <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,overflow:'hidden'}}>
              <div style={{display:'grid',gridTemplateColumns:'90px 56px 90px 90px 60px 108px 108px 100px 80px 110px',padding:'12px 20px',borderBottom:`1px solid ${T.border}`,background:T.sub}}>
                {['Ticker','Dir','Entry','Exit','Qty','Entry Date','Exit Date','Setup','Status','P&L'].map(h=><div key={h} style={{fontSize:10,color:T.dim,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase'}}>{h}</div>)}
              </div>
              {filtered.map(t=>{const p=pnl(t),pp=pct(t);return(
                <div key={t.id} className="tr" onClick={()=>{setEditTrade(t);setShowTrade(true);}} style={{display:'grid',gridTemplateColumns:'90px 56px 90px 90px 60px 108px 108px 100px 80px 110px',padding:'13px 20px',borderBottom:'1px solid #111827',alignItems:'center',background:T.panel}}>
                  <div style={{fontWeight:700,fontSize:13,color:T.text}}>{t.ticker}</div>
                  <Badge type={t.direction}>{t.direction==='LONG'?'L':'S'}</Badge>
                  <div style={{fontSize:12,color:'#94a3b8'}}>${f2(t.entry_price)}</div>
                  <div style={{fontSize:12,color:'#94a3b8'}}>{t.exit_price?`$${f2(t.exit_price)}`:'—'}</div>
                  <div style={{fontSize:12,color:T.muted}}>{t.quantity}</div>
                  <div style={{fontSize:11,color:T.muted}}>{t.entry_date}</div>
                  <div style={{fontSize:11,color:T.muted}}>{t.exit_date||'—'}</div>
                  <div style={{fontSize:11,color:T.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.setup}</div>
                  <Badge type={t.status}>{t.status}</Badge>
                  <div>{p!=null?<div><div style={{fontSize:12,fontWeight:700,color:p>=0?T.green:T.red}}>{fmtM(p)}</div><div style={{fontSize:10,color:p>=0?'rgba(52,211,153,0.6)':'rgba(248,113,113,0.6)'}}>{fmtP(pp)}</div></div>:<span style={{fontSize:11,color:T.blue}}>Open</span>}</div>
                </div>
              );})}
              {filtered.length===0&&<div style={{padding:'60px 0',textAlign:'center',color:T.dim,fontSize:13}}>No trades found</div>}
            </div>
          </>}

          {!loading&&page==='analytics'&&<>
            <div style={{display:'flex',gap:14,marginBottom:20,flexWrap:'wrap'}}>
              <StatCard label="Total P&L" value={fmtM(totalPnl)} color={totalPnl>=0?T.green:T.red}/>
              <StatCard label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${winners.length} of ${closed.length}`}/>
              <StatCard label="Profit Factor" value={profitFactor.toFixed(2)}/>
              <StatCard label="Avg Win" value={fmtM(avgWin)} color={T.green}/>
              <StatCard label="Avg Loss" value={fmtM(avgLoss)} color={T.red}/>
              <StatCard label="Expectancy" value={fmtM((winRate/100)*avgWin+(1-winRate/100)*avgLoss)} sub="Per trade"/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>Equity Curve</div>
                <div style={{fontSize:11,color:T.muted,marginBottom:16}}>Cumulative P&L per closed trade</div>
                <EquityCurve trades={trades}/>
              </div>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:16}}>Best & Worst</div>
                <div style={{fontSize:11,color:T.muted,marginBottom:10,fontWeight:600,textTransform:'uppercase'}}>Top Winners</div>
                {[...closed].sort((a,b)=>(pnl(b)||0)-(pnl(a)||0)).slice(0,3).map(t=><div key={t.id} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid #111827',fontSize:12}}><span style={{color:'#94a3b8',fontWeight:600}}>{t.ticker}</span><span style={{color:T.green,fontWeight:700}}>{fmtM(pnl(t))}</span></div>)}
                <div style={{fontSize:11,color:T.muted,marginTop:14,marginBottom:10,fontWeight:600,textTransform:'uppercase'}}>Top Losers</div>
                {[...closed].sort((a,b)=>(pnl(a)||0)-(pnl(b)||0)).slice(0,3).map(t=><div key={t.id} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid #111827',fontSize:12}}><span style={{color:'#94a3b8',fontWeight:600}}>{t.ticker}</span><span style={{color:T.red,fontWeight:700}}>{fmtM(pnl(t))}</span></div>)}
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:16}}>By Setup</div>
                {Object.entries(setupPnl).sort((a,b)=>b[1]-a[1]).map(([s,v])=>{const c=closed.filter(t=>t.setup===s);const wr=c.length?c.filter(t=>(pnl(t)||0)>0).length/c.length*100:0;return<div key={s} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:'1px solid #111827'}}><div><div style={{fontSize:12,fontWeight:600,color:'#94a3b8'}}>{s}</div><div style={{fontSize:11,color:T.muted}}>{c.length} trades · {wr.toFixed(0)}% WR</div></div><span style={{fontSize:13,fontWeight:700,color:v>=0?T.green:T.red}}>{fmtM(v)}</span></div>;})}
              </div>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:24}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:16}}>By Ticker</div>
                {Object.entries(closed.reduce((acc,t)=>{acc[t.ticker]=(acc[t.ticker]||0)+(pnl(t)||0);return acc},{})).sort((a,b)=>b[1]-a[1]).map(([tk,v])=><div key={tk} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:'1px solid #111827'}}><div style={{fontSize:12,fontWeight:700,color:'#94a3b8'}}>{tk}</div><span style={{fontSize:13,fontWeight:700,color:v>=0?T.green:T.red}}>{fmtM(v)}</span></div>)}
              </div>
            </div>
          </>}

          {!loading&&page==='psychology'&&<>
            <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:28,marginBottom:16}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Emotion Tracker</div>
              <div style={{fontSize:12,color:T.muted,marginBottom:24}}>How your emotional state correlates with P&L</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
                {Object.entries(emotionPnl).sort((a,b)=>b[1]-a[1]).map(([e,v])=>{const emo={Confident:'😎',Neutral:'😐',Excited:'🤩',Fearful:'😨',Frustrated:'😤',Calm:'🧘'};const cnt=closed.filter(t=>t.emotion===e).length;return<div key={e} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:10,padding:'18px 20px'}}><div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10}}><span style={{fontSize:24}}>{emo[e]||e[0]}</span><div><div style={{fontSize:13,fontWeight:600,color:T.text}}>{e}</div><div style={{fontSize:11,color:T.muted}}>{cnt} trades</div></div></div><div style={{fontSize:18,fontWeight:700,color:v>=0?T.green:T.red}}>{fmtM(v)}</div></div>;})}
              </div>
            </div>
            <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:28}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:20}}>Trade Notes</div>
              {closed.filter(t=>t.notes).map(t=>{const p=pnl(t);return<div key={t.id} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:10,padding:20,marginBottom:12}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}><div style={{display:'flex',gap:12,alignItems:'center'}}><div style={{width:38,height:38,borderRadius:9,background:t.direction==='LONG'?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:800,color:t.direction==='LONG'?T.green:T.red}}>{t.ticker}</div><div><div style={{fontSize:13,fontWeight:600,color:T.text}}>{t.ticker} · {t.setup}</div><div style={{fontSize:11,color:T.muted}}>{t.entry_date} → {t.exit_date}</div></div></div><span style={{fontSize:14,fontWeight:700,color:p>=0?T.green:T.red}}>{fmtM(p)}</span></div><p style={{fontSize:13,color:'#94a3b8',lineHeight:1.6,borderLeft:'2px solid #1e2535',paddingLeft:14,margin:0}}>{t.notes}</p></div>;})}
            </div>
          </>}

          {!loading&&page==='calendar'&&(
            <div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:16}}>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:28}}>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>P&L Calendar</div>
                <div style={{fontSize:12,color:T.muted,marginBottom:24}}>Green = profit · Red = loss · Intensity = magnitude</div>
                <PnLCalendar trades={trades}/>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:14}}>
                <StatCard label="Total P&L" value={fmtM(totalPnl)} color={T.green}/>
                <StatCard label="Trading Days" value={new Set(closed.map(t=>t.exit_date)).size}/>
                <StatCard label="Closed Trades" value={closed.length}/>
                <StatCard label="Open Positions" value={openCount} color={T.blue}/>
              </div>
            </div>
          )}

          {!loading&&page==='sync'&&(
            <div style={{maxWidth:680}}>
              <div style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:12,padding:28,marginBottom:16}}>
                <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>Import from CSV</div>
                <div style={{fontSize:12,color:T.muted,marginBottom:24}}>Upload your Fidelity or Robinhood export — trades saved to your account</div>
                {[{name:'Fidelity',icon:'🏦',steps:['Log in → Accounts & Trade → Activity & Orders → History','Select date range → Download CSV','Import below']},{name:'Robinhood',icon:'🟢',steps:['Account → Statements & History → History','Select date range → Export CSV','Import below']}].map(b=>(
                  <div key={b.name} style={{background:T.sub,border:`1px solid ${T.border}`,borderRadius:12,padding:20,marginBottom:12}}>
                    <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16}}>
                      <div style={{flex:1}}>
                        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}><span style={{fontSize:24}}>{b.icon}</span><div style={{fontSize:14,fontWeight:700,color:T.text}}>{b.name}</div></div>
                        <ol style={{paddingLeft:18,margin:0}}>{b.steps.map((s,i)=><li key={i} style={{fontSize:12,color:T.muted,marginBottom:4,lineHeight:1.5}}>{s}</li>)}</ol>
                      </div>
                      <button onClick={()=>setShowCSV(true)} style={{...BtnPrimary,whiteSpace:'nowrap',flexShrink:0}}>Import →</button>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{background:'rgba(99,102,241,0.08)',border:'1px solid rgba(99,102,241,0.2)',borderRadius:12,padding:20}}>
                <div style={{fontSize:13,fontWeight:600,color:'#818cf8',marginBottom:6}}>🚀 Auto-Sync Coming in Phase 3</div>
                <div style={{fontSize:12,color:T.muted,lineHeight:1.7}}>Phase 3 will connect directly to Robinhood API and Fidelity OAuth — no CSV export needed.</div>
              </div>
            </div>
          )}
        </div>
      </main>

      {showTrade&&<TradeModal trade={editTrade} onSave={saveTrade} onDelete={deleteTrade} onClose={()=>setShowTrade(false)} saving={saving}/>}
      {showCSV&&<CSVImportModal existingTrades={trades} onImport={importTrades} onClose={()=>{setShowCSV(false);setPage('log');}}/>}
    </div>
  );
}
