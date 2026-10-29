import type { ReactNode } from "react";
import { displayFor } from "../present";
import type { OptionsLine } from "../types";

interface OptionsTableProps {
  line: OptionsLine;
  /** Controls shown beside the numbers, such as the homeowner view button. */
  actions?: ReactNode;
}

/**
 * The options in the chat: label, payment, term and APR per product, the inputs they were
 * computed from, and the estimate footer. The full disclosure block is the homeowner view's.
 */
export function OptionsTable({ line, actions }: OptionsTableProps) {
  return (
    <section className="options-table" aria-label="Payment options">
      <div className="options-head">
        <div>
          <p className="options-echo">Based on {line.inputs_echo}</p>
          {line.argument_label ? <p className="options-argument">{line.argument_label}</p> : null}
        </div>
        {actions ? <div className="options-actions">{actions}</div> : null}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col">Payment</th>
              <th scope="col">Term</th>
              <th scope="col">APR</th>
            </tr>
          </thead>
          <tbody>
            {line.calculator_result.options.map((option) => {
              const cells = displayFor(line.options_display, option.product_id);
              if (cells === null) return null;
              return (
                <tr key={option.product_id}>
                  <th scope="row">
                    <span className="option-label">{option.label}</span>
                    <span className="option-name">{option.product_name}</span>
                  </th>
                  <td>{cells.payment_text}</td>
                  <td>{cells.term_text}</td>
                  <td>{cells.apr_text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="options-footer">{line.footer}</p>
    </section>
  );
}
