import { useEffect, useState } from 'react';
import { native } from 'ugly-app/native';
import { getActiveProjectPath } from './useSocket';

export type ProdDeployState = 'checking' | 'deployed' | 'undeployed';

/**
 * Whether the open project has ever been deployed — i.e. its committed `.uglyapp`
 * carries a `deployTarget` (with a `workerUrl`). Prod-scoped panels (Database,
 * Errors, …) use this to show a "publish first" prompt for a never-deployed
 * project instead of a confusing raw error (there's no prod D1/Neon yet). `enabled`
 * gates the check so dev-mode panels skip the `.uglyapp` read entirely.
 */
export function useProdDeployGate(enabled: boolean): ProdDeployState {
  const [state, setState] = useState<ProdDeployState>('checking');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState('checking');
    const cwd = getActiveProjectPath();
    if (!cwd) { setState('undeployed'); return; }
    void (async () => {
      try {
        const ua = JSON.parse(await native.fs.readFile(`${cwd}/.uglyapp`)) as {
          deployTarget?: { workerUrl?: string } | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (cancelled) return;
        setState(ua.deployTarget?.workerUrl ? 'deployed' : 'undeployed');
      } catch {
        // No `.uglyapp` yet (ENOENT) = never published.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (cancelled) return;
        setState('undeployed');
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);
  return state;
}
