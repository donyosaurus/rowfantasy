// Fail-closed balance UI (Wave 1 #6).
// Rendered whenever useWalletBalance returns status: 'error'. By design, this
// component does NOT show any number — never coerce a missing balance to $0.00.
// Money-action buttons MUST live inside the `status === 'ready'` branch and
// therefore are not rendered when this component is shown.

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BalanceUnavailableProps {
  error?: string;
  onRetry?: () => void | Promise<void>;
  className?: string;
}

export function BalanceUnavailable({ error, onRetry, className }: BalanceUnavailableProps) {
  return (
    <div
      role="alert"
      className={
        'flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive ' +
        (className ?? '')
      }
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        Balance temporarily unavailable
        {error ? <span className="ml-1 opacity-70">({error})</span> : null}
      </span>
      {onRetry && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void onRetry()}
          className="h-7 px-2"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Retry
        </Button>
      )}
    </div>
  );
}
