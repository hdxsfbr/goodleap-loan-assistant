import { isDeepStrictEqual } from "node:util";
import {
  HomeownerViewPropsSchema,
  type CalculatorResult,
  type DisclosureBlock,
  type HomeownerViewProps,
  type Surface,
} from "@shared/schemas";
import { AppError } from "../errors.js";
import { CATALOG } from "./catalog.js";
import {
  WHAT_HAPPENS_NEXT,
  fixedSentenceForTerm,
  renderDisclosureBlock,
  renderOptionsDisplay,
} from "./disclosures/template.js";

// Where model-adjacent text can reach a person, and what must travel with it (Technical Plan
// section 11). The reviewer and audit views carry no borrower-facing text and no model prose, so
// they are not surfaces.

export interface SurfaceRule {
  /** True when the homeowner can read it. */
  borrower_facing: boolean;
  /** `required_block`: a disclosure block must accompany it, enforced by type. `chat_footer`: the footer under payment figures. */
  disclosure: "required_block" | "chat_footer";
  /** Which model-written text the surface may carry. */
  model_prose: "explanation_or_canned_sentence" | "judged_once_per_turn";
}

export const SURFACES = {
  homeowner_view: {
    borrower_facing: true,
    disclosure: "required_block",
    model_prose: "explanation_or_canned_sentence",
  },
  contractor_chat: {
    borrower_facing: false,
    disclosure: "chat_footer",
    model_prose: "judged_once_per_turn",
  },
} as const satisfies Record<Surface, SurfaceRule>;

/** The surfaces the homeowner can read, derived from the table above. */
export type BorrowerFacingSurface = {
  [S in Surface]: (typeof SURFACES)[S]["borrower_facing"] extends true ? S : never;
}[Surface];

/** Anything written for a borrower-facing surface. It cannot be built without its disclosure block. */
export interface BorrowerFacingMessage {
  surface: BorrowerFacingSurface;
  text: string;
  disclosure_block: DisclosureBlock;
}

export interface ComposeHomeownerViewInput {
  options: CalculatorResult;
  /** Required and not nullable: a homeowner view cannot be composed without it. */
  disclosure_block: DisclosureBlock;
  /** The turn's judged explanation, or the canned sentence when the turn had none. */
  explanation: string;
  /** The catalog's plain-language sentence for each product shown. */
  mechanic_sentences: HomeownerViewProps["mechanic_sentences"];
  /** The `template@<sha>` version the disclosure block was rendered with. */
  template_version: string;
}

/**
 * The homeowner view as a pure function of its inputs. The disclosure block must be exactly the
 * canonical rendering of the options shown, figures and fixed statements included, and every
 * product shown needs its mechanic sentence; a mismatch is a bug in the caller and throws rather
 * than render a view whose disclosures belong to different options. A fixed option on a term
 * other than the catalog's shows the term-aware sentence in place of the catalog's.
 */
export function composeHomeownerView(input: ComposeHomeownerViewInput): HomeownerViewProps {
  const { options, disclosure_block, explanation, mechanic_sentences, template_version } = input;
  if (!disclosure_block) {
    throw new AppError("internal", "A homeowner view cannot be composed without a disclosure block.");
  }
  let canonical: DisclosureBlock;
  try {
    canonical = renderDisclosureBlock(options.options);
  } catch (cause) {
    throw new AppError("internal", "The options shown cannot be disclosed.", { cause });
  }
  if (!isDeepStrictEqual(disclosure_block, canonical)) {
    throw new AppError("internal", "The disclosure block does not match the options shown.");
  }
  const sentences: HomeownerViewProps["mechanic_sentences"] = { ...mechanic_sentences };
  for (const option of options.options) {
    if (!sentences[option.product_id]) {
      throw new AppError("internal", `The homeowner view has no mechanic sentence for ${option.product_id}.`);
    }
    if (option.mechanic === "fixed" && option.term_months !== catalogTermMonths(option.product_id)) {
      sentences[option.product_id] = fixedSentenceForTerm(option.term_months);
    }
  }
  return HomeownerViewPropsSchema.parse({
    options,
    options_display: renderOptionsDisplay(options.options),
    disclosure_block,
    explanation,
    mechanic_sentences: sentences,
    what_happens_next: WHAT_HAPPENS_NEXT,
    template_version,
  });
}

/** The term the catalog's own sentence for a product describes; undefined for a product the catalog does not list. */
function catalogTermMonths(product_id: string): number | undefined {
  return CATALOG.products.find((product) => product.id === product_id)?.term_months;
}
