declare const __KEEPER_URL__: string;
declare const __KEEPER_TOKEN__: string;
declare const __OWNER_SIGNER_URL__: string;

interface Window {
  qorex?: { native?: { capabilities?: unknown }; evm?: unknown };
}
