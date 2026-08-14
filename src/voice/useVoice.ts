/**
 * Push-to-talk via the Web Speech API (webkit-prefixed on iOS/Safari).
 * Lifted from "/Users/rajkumars/Documents/Fun projects/asset-lens/src/hooks/useVoice.ts"
 * — hand-rolled RecognitionLike typings, single-shot toggle (continuous=false,
 * interimResults=false), returns { supported, listening, toggle }.
 */
import { useEffect, useRef, useState } from 'react';

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export function useVoice(
  onCommand: (text: string) => void,
  onInterim?: (finalText: string, pendingText: string) => void,
) {
  const [listening, setListening] = useState(false);
  const interimRef = useRef(onInterim);
  interimRef.current = onInterim;
  const finalRef = useRef('');
  const [supported] = useState(
    () =>
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
  );
  const recRef = useRef<RecognitionLike | null>(null);
  const cbRef = useRef(onCommand);
  cbRef.current = onCommand;

  useEffect(() => {
    return () => recRef.current?.stop();
  }, []);

  const toggle = () => {
    if (!supported) return;
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as new () => RecognitionLike;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = false;
    // interim results stream the words in as they are recognised — the Effi
    // panel renders them live (confirmed words solid, the tail dimmed)
    rec.interimResults = true;
    rec.onresult = (e) => {
      let final = '';
      let pending = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? '';
        if (r.isFinal) final += t;
        else pending += t;
      }
      interimRef.current?.(final, pending);
      finalRef.current = final;
    };
    // deliver on END, not per-event: engines split finals across events, and
    // the command must be the whole utterance
    rec.onend = () => {
      setListening(false);
      const text = finalRef.current.trim();
      finalRef.current = '';
      if (text) cbRef.current(text);
    };
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  return { supported, listening, toggle };
}
