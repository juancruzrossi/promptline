interface InlineAlertProps {
  message: string;
  className?: string;
}

export function InlineAlert({ message, className = '' }: InlineAlertProps) {
  return (
    <p
      role="alert"
      aria-live="assertive"
      className={['text-xs text-red-400', className].join(' ').trim()}
    >
      {message}
    </p>
  );
}
