import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import AuthScreen from './AuthScreen';
import TradingJournal from './TradingJournal';

export default function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'#0b0f1a', fontFamily:'Inter,system-ui,sans-serif' }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ width:44, height:44, background:'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius:10, display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:22, marginBottom:14 }}>📈</div>
          <div style={{ color:'#5a6478', fontSize:13 }}>Loading TradeLog...</div>
        </div>
      </div>
    );
  }

  if (!session) return <AuthScreen />;
  return <TradingJournal session={session} />;
}
