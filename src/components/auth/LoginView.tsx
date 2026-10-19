import React from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Shield } from 'lucide-react';

interface LoginViewProps {
  loginError: string | null;
  onLogin: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ loginError, onLogin }) => {
  return (
    <div className="min-h-screen relative flex items-center justify-center p-6 font-sans overflow-hidden">
      {/* Background Image: Stretched and Fitted per /impeccable */}
      <div
        className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-no-repeat bg-cover bg-center"
        style={{
          backgroundImage: `url('/header_bg.webp'), url('/header_bg.png')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundAttachment: 'fixed',
        }}
      />
      {/* Calming, high-contrast overlay */}
      <div className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-slate-900/25 backdrop-blur-[4px]" />

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-md w-full bg-white/95 backdrop-blur-md border border-white/60 rounded-3xl p-8 sm:p-10 shadow-2xl text-center relative z-10"
      >
        <div className="w-20 h-20 bg-teal-50/90 border border-teal-100 rounded-2xl flex items-center justify-center mx-auto mb-6 p-2 shadow-xs">
          <img
            src="/elite_logo.png"
            alt="Elite Hospital Logo"
            width={64}
            height={64}
            className="w-16 h-16 object-contain"
            referrerPolicy="no-referrer"
          />
        </div>

        <h1 className="text-2xl font-black mb-1.5 text-slate-900 tracking-tight font-display">
          Elite Pricelist Explorer
        </h1>
        <p className="text-xs text-teal-800 font-bold uppercase tracking-wider mb-2">
          By Dr. Mohanad El Ma'moun
        </p>
        <p className="text-sm text-slate-600 font-medium mb-8 leading-relaxed max-w-xs mx-auto">
          Please sign in with your hospital or corporate Google account to access contracted pricelists.
        </p>

        {loginError && (
          <div
            className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-2xl text-left text-xs text-rose-950 font-medium space-y-2.5 shadow-xs max-h-[300px] overflow-y-auto"
            role="alert"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-rose-800 font-extrabold text-[13px]">
              <AlertCircle size={16} />
              <span>Authentication Notice</span>
            </div>
            <p className="font-semibold break-words leading-relaxed text-rose-900 bg-rose-100/60 p-2.5 rounded-xl font-mono text-[11px]">
              {loginError}
            </p>
            <div className="text-[11px] leading-relaxed pt-2 border-t border-rose-100 space-y-1.5 text-rose-900 font-medium">
              <p className="font-bold">Setup Instructions for Vercel:</p>
              <p>
                1. <strong>Authorized Domains:</strong> Open your Firebase Console &gt; Authentication &gt; Settings &gt; Authorized domains and add your Vercel deployment domain.
              </p>
              <p>
                2. <strong>Environment Variables:</strong> Verify that <code>VITE_FIREBASE_API_KEY</code> and project IDs are set in your project environment settings.
              </p>
            </div>
          </div>
        )}

        <button
          onClick={onLogin}
          className="w-full bg-slate-900 hover:bg-slate-800 text-white px-6 py-3.5 rounded-2xl font-bold transition-all flex items-center justify-center gap-3.5 shadow-sm hover:shadow-md active:scale-98 cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none min-h-[44px]"
          aria-label="Sign in with your Google account"
        >
          <img
            src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            alt=""
            width={20}
            height={20}
            className="w-5 h-5 shrink-0"
            aria-hidden="true"
          />
          <span className="text-sm font-semibold tracking-wide">Continue with Google</span>
        </button>

        <div className="mt-8 pt-6 border-t border-slate-100 flex items-center justify-center gap-2 text-slate-400 text-xs font-semibold">
          <Shield size={14} className="text-teal-600" />
          <span>HIPAA & Hospital Staff Secure Access</span>
        </div>
      </motion.div>
    </div>
  );
};
