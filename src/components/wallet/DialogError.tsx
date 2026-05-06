import { AlertCircle } from "lucide-react";

interface DialogErrorProps {
  message: string | null;
}

export const DialogError = ({ message }: DialogErrorProps) => {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
};

export default DialogError;
