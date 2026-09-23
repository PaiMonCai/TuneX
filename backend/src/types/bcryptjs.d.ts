/**
 * Minimal ambient declaration for `bcryptjs` (the package ships no types and
 * there is no @types/bcryptjs installed). Only the surface this project uses is
 * declared: `hash` and `compare`.
 */
declare module "bcryptjs" {
  export function hash(data: string, saltOrRounds: string | number): Promise<string>;
  export function hashSync(data: string, saltOrRounds: string | number): string;
  export function compare(data: string, encrypted: string): Promise<boolean>;
  export function compareSync(data: string, encrypted: string): boolean;
  const _default: {
    hash: typeof hash;
    hashSync: typeof hashSync;
    compare: typeof compare;
    compareSync: typeof compareSync;
  };
  export default _default;
}
