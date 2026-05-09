import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Substituto leve de `useLiveQuery` (Dexie) para o mundo Supabase.
 *
 * Roda a query assim que o componente monta (ou quando `deps` mudam),
 * mantém o último resultado em estado e re-executa quando recebe a mensagem
 * `CRM_IGNIS_DB_UPDATED` (broadcast de qualquer escrita feita pelos repos).
 *
 * Não usa Supabase Realtime — a UX de auto-refresh continua via o canal
 * já existente de mensagens chrome.runtime, mantendo paridade com a era Dexie.
 */
export function useReactiveQuery<T>(
  query: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): { data: T | undefined; loading: boolean; error: unknown; refetch: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);

  // Guarda a última versão da query para que o listener de mensagens sempre
  // chame a versão atual (sem precisar reanexar listener a cada render).
  const queryRef = useRef(query);
  queryRef.current = query;

  // ID da execução: descarta resultados antigos quando deps mudam.
  const genRef = useRef(0);

  const run = useCallback(() => {
    const gen = ++genRef.current;
    setLoading(true);
    queryRef
      .current()
      .then((res) => {
        if (gen !== genRef.current) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (gen !== genRef.current) return;
        setError(err);
      })
      .finally(() => {
        if (gen !== genRef.current) return;
        setLoading(false);
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    run();
  }, deps);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.runtime?.onMessage) return;
    const handler = (msg: any) => {
      if (msg?.type === "CRM_IGNIS_DB_UPDATED") run();
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(handler);
      } catch {
        /* ignore */
      }
    };
  }, [run]);

  return { data, loading, error, refetch: run };
}
