import type { DisclosureBlock } from "@shared/schemas";

// Renders one option of the disclosure block as the template composed it: the four-cell TILA box,
// the schedule line and, for a deferred option, the consequence line. Every string is printed as
// given; the component formats and computes nothing. The estimate statement and the RESPA line are
// block-level text the page places itself.

interface DisclosureBlockViewProps {
  block: DisclosureBlock;
  productId: string;
}

export function DisclosureBlockView({ block, productId }: DisclosureBlockViewProps) {
  const option = block.options.find((candidate) => candidate.product_id === productId);
  if (!option) throw new Error(`The disclosure block has no entry for product ${productId}.`);
  return (
    <div className="tila">
      <dl className="tila-box">
        <div className="tila-cell">
          <dt>Annual percentage rate</dt>
          <dd>{option.apr}</dd>
        </div>
        <div className="tila-cell">
          <dt>Finance charge</dt>
          <dd>{option.finance_charge}</dd>
        </div>
        <div className="tila-cell">
          <dt>Amount financed</dt>
          <dd>{option.amount_financed}</dd>
        </div>
        <div className="tila-cell">
          <dt>Total of payments</dt>
          <dd>{option.total_of_payments}</dd>
        </div>
      </dl>
      <p className="schedule-line">{option.schedule_line}</p>
      {option.consequence_line ? <p className="consequence-line">{option.consequence_line}</p> : null}
    </div>
  );
}
