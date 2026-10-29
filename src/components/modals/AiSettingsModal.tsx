import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, X, Check, Key, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { getGeminiApiKey, setGeminiApiKey } from '../../services/aiMatchService';
import { GoogleGenAI } from '@google/genai';

interface AiSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onKeyUpdated?: () => void;
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({
  isOpen,
  onClose,
  onKeyUpdated,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setApiKey(getGeminiApiKey());
      setTestResult(null);
    }
  }, [isOpen]);

  const handleSave = () => {
    setGeminiApiKey(apiKey);
    onKeyUpdated?.();
    setTestResult({
      success: true,
      message: 'Gemini API key saved to browser local storage.',
    });
    setTimeout(() => {
      onClose();
    }, 1200);
  };

  const handleTestKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setTestResult({
        success: false,
        message: 'Please enter a valid Gemini API key first.',
      });
      return;
    }

    setTesting(true);
    setTestResult(null);

    const testModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
    let lastError: any = null;
    let had429 = false;

    for (const model of testModels) {
      try {
        const ai = new GoogleGenAI({ apiKey: trimmed });
        const res = await Promise.race([
          ai.models.generateContent({
            model,
            contents: 'ping',
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout querying model')), 5000)
          ),
        ]);

        if (res && res.text) {
          setTestResult({
            success: true,
            message: `Key verified successfully! Access to ${model} confirmed.`,
          });
          setGeminiApiKey(trimmed);
          onKeyUpdated?.();
          setTesting(false);
          return;
        }
      } catch (err: any) {
        lastError = err;
        const msg = (err?.message || String(err)).toLowerCase();
        if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
          had429 = true;
        } else if (msg.includes('403') || msg.includes('api key not valid') || msg.includes('permission_denied')) {
          // Invalid key - stop trying other models
          setTestResult({
            success: false,
            message: 'Invalid API key or permission denied (403). Please verify in Google AI Studio.',
          });
          setTesting(false);
          return;
        }
      }
    }

    if (had429) {
      // 429 proves the key was accepted and authenticated by Google, but RPM/RPD quota is exhausted
      setGeminiApiKey(trimmed);
      onKeyUpdated?.();
      setTestResult({
        success: true,
        message:
          'Key verified successfully! (Note: Current Google quota is temporarily exhausted [429]; the platform will use automatic model switching & local fallback until your quota resets).',
      });
    } else {
      setTestResult({
        success: false,
        message: lastError?.message || 'Verification failed. Please check your internet connection.',
      });
    }
    setTesting(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 max-w-lg w-full shadow-2xl relative text-left"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
      >
        <button
          onClick={onClose}
          className="absolute right-5 top-5 p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div>
            <h3 id="ai-settings-title" className="text-lg font-bold text-slate-900 font-display">
              Gemini AI Settings
            </h3>
            <p className="text-xs text-slate-500 font-medium">
              Configure your Google Gemini API key for semantic matching of custom procedure queries.
            </p>
          </div>
        </div>

        <div className="space-y-4 my-5">
          <div>
            <label htmlFor="gemini-key-input" className="block text-xs font-bold text-slate-700 mb-1.5">
              Gemini API Key
            </label>
            <div className="relative">
              <input
                id="gemini-key-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-slate-50 border border-slate-300 focus:border-teal-600 rounded-xl pl-9 pr-4 py-2.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5 flex items-center justify-between">
              <span>Your key is stored securely in your browser's local storage.</span>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-teal-700 hover:text-teal-900 font-bold inline-flex items-center gap-0.5"
              >
                <span>Get key</span>
                <ExternalLink size={10} />
              </a>
            </p>
          </div>

          {testResult && (
            <div
              className={`p-3.5 rounded-xl border text-xs font-medium flex items-start gap-2.5 ${
                testResult.success
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-900'
              }`}
            >
              {testResult.success ? (
                <Check size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={16} className="text-rose-600 shrink-0 mt-0.5" />
              )}
              <span className="leading-relaxed">{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={handleTestKey}
            disabled={testing || !apiKey.trim()}
            className="px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer min-h-[42px]"
          >
            {testing ? (
              <>
                <Loader2 size={14} className="animate-spin text-teal-600" />
                <span>Testing Key…</span>
              </>
            ) : (
              <span>Verify & Test</span>
            )}
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={testing}
            className="px-5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs uppercase tracking-wider transition-colors shadow-xs cursor-pointer min-h-[42px]"
          >
            Save Key
          </button>
        </div>
      </motion.div>
    </div>
  );
};
