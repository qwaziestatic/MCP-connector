/** What the window shows while the user signs in. */
export type SignInPrompt =
  /** A code the user enters on the service's site. */
  | { readonly kind: "code"; readonly userCode: string; readonly verificationUri: string; readonly expiresAt: string }
  /** The browser is open on the service's consent page. */
  | { readonly kind: "browser" };

/** One sign-in at a time for one connector. Each sign-in kind implements it. */
export interface SignInFlow {
  /** Starts signing in and says what to show. Throws if this copy cannot sign in to the service. */
  start(): Promise<SignInPrompt>;
  /** Opens the page where the user enters the code. Only for "code" prompts. */
  openPage(): Promise<void>;
  /** Resolves once the user approved and the token is saved. */
  finish(): Promise<void>;
  cancel(): void;
}
