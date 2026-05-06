export const ERROR_MESSAGES = {
  BALANCE_UNAVAILABLE: 'Balance temporarily unavailable. Please retry.',
  INSUFFICIENT_FUNDS: 'Insufficient balance.',
  INTERNAL_ERROR: 'An error occurred. Please try again later.',
  RATE_LIMIT: 'Too many requests. Please try again later.',
  UNAUTHORIZED: 'Authentication required.',
} as const;

export type ErrorMessageKey = keyof typeof ERROR_MESSAGES;
