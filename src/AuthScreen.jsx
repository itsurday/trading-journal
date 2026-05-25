import { useState } from 'react';
import { supabase } from './supabaseClient';

const T = { bg:'#0b0f1a', panel:'#131720', border:'#1e2535', sub:'#0e1420', text:'#e2e8f0', muted:'#5a6478', dim:'#3d4f6b', green:'#34d399', red:'#f87171', purple:'#818cf8' };
const IS = { width:'100%', background:T.sub, border:'1px solid #2d3748', borderRadius:8, color:T.text, fontSize:14, padding:'12px 16px', outline:'none', fontFamily:'inherit', boxSizing:'border-box' };
const BtnPrimary = { width:'100%', background:'linear-gradient(135deg,#6366f1,#8b5cf6)', border:'none', borderRadius:8, color:'#fff', fontSize:14, fontWeight:600, padding:'13px', cursor:'pointer' };

export default function AuthScreen() {
  const [mode, setMode]         = useState('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [message, setMessage]   = useState('');

  const handleSubmit = async () => {
    setError(''); setMessage(''); setLoading(true);
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage('Account created! Check your email to confirm, then log in.');
        setMode('login');
      } else if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (error) throw error;
        setMessage('Password reset email sent!');
        setMode('login');
      }
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handleKey = e => { if (e.key === 'Enter') handleSubmit(); };

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:T.bg, fontFamily:"'Inter',system-ui,sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}input{font-family:inherit}`}</style>
      <div style={{ width:'100%', maxWidth:400, padding:24 }}>
        <div style={{ textAlign:'center', marginBottom:36 }}>
          <div style={{ width:52, height:52, background:'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius:14, display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:26, marginBottom:14 }}>📈</div>
          <div style={{ fontSize:24, fontWeight:800, color:T.text, letterSpacing:'-0.02em' }}>TradeLog</div>
          <div style={{ fontSize:13, color:T.muted, marginTop:4 }}>Professional Trading Journal</div>
        </div>
        <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:16, padding:32 }}>
          <h2 style={{ fontSize:18, fontWeight:700, color:T.text, marginBottom:6 }}>
            {mode==='login'?'Welcome back':mode==='signup'?'Create account':'Reset password'}
          </h2>
          <p style={{ fontSize:13, color:T.muted, marginBottom:24 }}>
            {mode==='login'?'Sign in to your journal':mode==='signup'?'Start tracking your trades':"We'll send you a reset link"}
          </p>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, color:T.muted, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:6 }}>Email</label>
            <input style={IS} type="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={handleKey} autoFocus/>
          </div>
          {mode !== 'reset' && (
            <div style={{ marginBottom:20 }}>
              <label style={{ display:'block', fontSize:11, color:T.muted, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:6 }}>Password</label>
              <input style={IS} type="password" placeholder={mode==='signup'?'Min 6 characters':'Your password'} value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={handleKey}/>
            </div>
          )}
          {error   && <div style={{ background:'rgba(248,113,113,0.1)', border:'1px solid rgba(248,113,113,0.3)', borderRadius:8, padding:'10px 14px', color:T.red,   fontSize:13, marginBottom:16 }}>⚠️ {error}</div>}
          {message && <div style={{ background:'rgba(52,211,153,0.1)',  border:'1px solid rgba(52,211,153,0.3)',  borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13, marginBottom:16 }}>✅ {message}</div>}
          <button style={{ ...BtnPrimary, opacity:loading?0.7:1 }} onClick={handleSubmit} disabled={loading}>
            {loading?'Please wait...':mode==='login'?'Sign In':mode==='signup'?'Create Account':'Send Reset Link'}
          </button>
          <div style={{ display:'flex', alignItems:'center', gap:12, margin:'20px 0' }}>
            <div style={{ flex:1, height:1, background:T.border }}/><span style={{ fontSize:11, color:T.dim }}>OR</span><div style={{ flex:1, height:1, background:T.border }}/>
          </div>
          <button onClick={async()=>{ await supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin } }); }}
            style={{ width:'100%', background:T.sub, border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontSize:14, fontWeight:500, padding:'12px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
            Continue with Google
          </button>
          <div style={{ marginTop:20, textAlign:'center', fontSize:13, color:T.muted }}>
            {mode==='login'&&<><span>No account? </span><button onClick={()=>{setMode('signup');setError('');setMessage('');}} style={{background:'none',border:'none',color:T.purple,cursor:'pointer',fontSize:13,fontWeight:600}}>Sign up free</button><span style={{margin:'0 8px'}}>·</span><button onClick={()=>{setMode('reset');setError('');setMessage('');}} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:13}}>Forgot password?</button></>}
            {mode==='signup'&&<><span>Have an account? </span><button onClick={()=>{setMode('login');setError('');setMessage('');}} style={{background:'none',border:'none',color:T.purple,cursor:'pointer',fontSize:13,fontWeight:600}}>Sign in</button></>}
            {mode==='reset'&&<button onClick={()=>{setMode('login');setError('');setMessage('');}} style={{background:'none',border:'none',color:T.purple,cursor:'pointer',fontSize:13,fontWeight:600}}>← Back to sign in</button>}
          </div>
        </div>
        <p style={{ textAlign:'center', fontSize:11, color:T.dim, marginTop:20 }}>Your data is private and secured by Supabase</p>
      </div>
    </div>
  );
}
