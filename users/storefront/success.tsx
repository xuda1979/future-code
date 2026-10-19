'use client';
import { useEffect, useState } from 'react';
export default function Success() {
  const [state, setState] = useState('checking');
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    if (!sessionId) { setState('missing'); return; }
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let attempts = 0;
    async function poll() {
      try {
        const response = await fetch('/api/order/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (cancelled) return;
        setState(result.state);
        if (result.state === 'processing' && ++attempts < 10) timer = setTimeout(poll, 5000);
      } catch { if (!cancelled) setState('delayed'); }
    }
    poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  const content: Record<string, [string, string]> = {
    checking: ['Checking your order.', 'Please wait while we check the payment confirmation.'],
    processing: ['Your order is processing.', 'We are waiting for payment confirmation or license email delivery. There is no need to pay again. If this persists, contact support with your Stripe receipt.'],
    delivered: ['Your license email is on its way.', 'Payment is confirmed and your license email has been sent. Check the inbox and spam folder for the address you used at checkout.'],
    reversed: ['This payment has been reversed.', 'The license for this order is unavailable. Contact support if you think this is an error.'],
    missing: ['Order reference missing.', 'Open the confirmation link from your original checkout, or contact support with your Stripe receipt.'],
    delayed: ['We could not check the order yet.', 'Do not pay again. Contact support with your Stripe receipt if your license email has not arrived.'],
  };
  const [title, description] = content[state] || content.delayed;
  return <main style={{ maxWidth: 760, padding: '90px 28px' }}><a className="company" href="/">Future Code</a><p className="eyebrow" style={{ marginTop: 60 }}>ORDER & LICENSE</p><h1 style={{ fontSize: 52 }}>{title}</h1><p className="intro">{description}</p><p style={{ margin: '30px 0', fontSize: 14 }}>Support: <a style={{ textDecoration: 'underline' }} href="mailto:exutechnology@gmail.com">exutechnology@gmail.com</a></p><a className="button primary" style={{ display: 'inline-flex' }} href="/#downloads">Back to downloads ↓</a></main>;
}
