import { useEffect, useState } from 'react';
import { openQrStream } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../components/Spinner';

type ConnectionState = 'connecting' | 'waiting_qr' | 'ready' | 'error';

export function SetupPage() {
  const navigate = useNavigate();
  const [qr, setQr] = useState<string>('');
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void openQrStream(
      (nextQr) => {
        setQr(nextQr);
        setState('waiting_qr');
      },
      (connected) => {
        if (connected) {
          setState('ready');
        } else {
          setState('waiting_qr');
        }
      },
      (message) => {
        setState('error');
        setErrorMessage(message);
      },
    ).then((fn) => {
      dispose = fn;
    });
    return () => dispose?.();
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          WhatsApp Setup
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Link your WhatsApp account by scanning the QR code below.
        </p>
      </div>

      <div className="card">
        {state === 'connecting' && (
          <div className="flex flex-col items-center gap-4 py-12">
            <Spinner size="lg" />
            <p className="text-sm text-gray-400">Connecting to WhatsApp service...</p>
          </div>
        )}

        {state === 'waiting_qr' && !qr && (
          <div className="flex flex-col items-center gap-4 py-12">
            <Spinner size="lg" />
            <p className="text-sm text-gray-400">Waiting for QR code from WhatsApp...</p>
          </div>
        )}

        {state === 'waiting_qr' && qr && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              <p className="text-sm font-medium text-amber-300">
                QR code received — scan with WhatsApp
              </p>
            </div>
            <div className="mx-auto w-fit rounded-xl border border-gray-700/60 bg-white p-4">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(qr)}`}
                alt="WhatsApp pairing QR code"
                className="h-72 w-72"
              />
            </div>
            <p className="text-xs text-gray-500">
              Open WhatsApp → Settings → Linked Devices → Link a Device → Scan this QR
            </p>
          </div>
        )}

        {state === 'ready' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-900/50">
              <svg className="h-8 w-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="text-center">
              <p className="font-semibold text-emerald-300">WhatsApp Connected</p>
              <p className="mt-1 text-sm text-gray-400">
                Session is active. You can proceed to the dashboard.
              </p>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-900/50">
              <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-center text-sm text-red-300">{errorMessage}</p>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button className="btn-success" onClick={() => navigate('/dashboard')}>
          Continue to Dashboard →
        </button>
      </div>
    </div>
  );
}
