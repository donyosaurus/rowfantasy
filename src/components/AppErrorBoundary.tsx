import React from 'react';
import { ErrorBoundary, FallbackProps } from 'react-error-boundary';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

const FallbackUI = ({ resetErrorBoundary }: FallbackProps) => (
  <div
    role="alert"
    className="flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-card p-8 text-center min-h-[40vh]"
  >
    <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
    <div className="space-y-2 max-w-md">
      <h2 className="text-xl font-semibold text-foreground">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        The page hit an unexpected error. Your account is safe and no funds were affected.
      </p>
    </div>
    <Button onClick={resetErrorBoundary} variant="default">
      Try again
    </Button>
  </div>
);

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
  fallback?: React.ComponentType<FallbackProps>;
}

export const AppErrorBoundary = ({ children, onReset, fallback }: AppErrorBoundaryProps) => (
  <ErrorBoundary
    FallbackComponent={fallback ?? FallbackUI}
    onReset={onReset}
    onError={(error, info) => {
      // TODO Wave 5: route to Sentry
      // eslint-disable-next-line no-console
      console.error('[AppErrorBoundary]', error, info);
    }}
  >
    {children}
  </ErrorBoundary>
);

export default AppErrorBoundary;
