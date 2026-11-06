import * as Schema from "effect/Schema";

/** The user's answer to a secret request. Values go to the server only, never back out. */
export const SecretResponse = Schema.Union([
  Schema.TaggedStruct("typed", { value: Schema.String }),
  /** A 1Password secret reference (`op://vault/item/field`); the server reads it with the `op` CLI. */
  Schema.TaggedStruct("onePassword", { reference: Schema.String }),
  Schema.TaggedStruct("decline", {}),
]);
export type SecretResponse = typeof SecretResponse.Type;

export const OnePasswordStatus = Schema.Struct({
  /** The `op` CLI was found. */
  installed: Schema.Boolean,
  /** It can read items now (signed in, or unlocked through the desktop app). */
  ready: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type OnePasswordStatus = typeof OnePasswordStatus.Type;

export const OnePasswordItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  vaultId: Schema.String,
  vault: Schema.String,
  category: Schema.String,
  /** Username, URL or similar, as 1Password shows under the title. */
  subtitle: Schema.NullOr(Schema.String),
});
export type OnePasswordItem = typeof OnePasswordItem.Type;

/** A field of an item, without its value. */
export const OnePasswordField = Schema.Struct({
  label: Schema.String,
  type: Schema.String,
  section: Schema.NullOr(Schema.String),
  reference: Schema.String,
});
export type OnePasswordField = typeof OnePasswordField.Type;
