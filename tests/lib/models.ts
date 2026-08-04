// Fixture models for tests that need one concrete provider model rather than a catalog.
// Projecting straight from Pi's bundled metadata keeps fixtures honest: a model Pi stops
// shipping fails the fixture instead of silently becoming undefined.

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type BridgeModel, projectCatalogModels } from "../../src/models.js";

export function bridgeModel(id: string): BridgeModel {
  const [model] = projectCatalogModels(getBuiltinModels("anthropic"), new Set([id]));
  if (!model) throw new Error(`Pi's Anthropic catalog has no model ${id}`);
  return model;
}
