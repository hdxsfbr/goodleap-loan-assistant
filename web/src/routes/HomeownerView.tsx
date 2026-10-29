import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { HomeownerViewPropsSchema, type HomeownerViewProps } from "@shared/schemas";
import { DisclosureBlockView } from "../components/DisclosureBlockView";
import { UNREADABLE_REPLY_MESSAGE } from "../copy";
import { disclosureCovers, displayCovers, displayFor, orderByTerm } from "../present";
import { contractorPath, DEFAULT_APPLICATION_ID } from "../routes";

/**
 * The borrower-facing surface: a full-screen, pure rendering of `HomeownerViewProps` read from
 * navigation state. No chat, form, badges or contractor chrome; every number and sentence is
 * printed as the server composed it.
 */
export function HomeownerView() {
  const params = useParams();
  const applicationId = params.applicationId ?? DEFAULT_APPLICATION_ID;
  const location = useLocation();
  const parsed = HomeownerViewPropsSchema.safeParse(location.state);
  // The contractor page may have been scrolled; the homeowner reads from the top. The effect returns
  // nothing: `scrollTo` can return a promise, and React treats any returned value as a cleanup function.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  const back = (
    <Link className="back-link" to={contractorPath(applicationId)} replace>
      Back to application
    </Link>
  );

  if (!parsed.success) {
    return (
      <div className="homeowner">
        <div className="homeowner-bar">{back}</div>
        <main className="homeowner-main">
          <p className="homeowner-empty">Open this from the application.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="homeowner">
      <div className="homeowner-bar">{back}</div>
      <main className="homeowner-main">
        <HomeownerOptions props={parsed.data} />
      </main>
    </div>
  );
}

function HomeownerOptions({ props }: { props: HomeownerViewProps }) {
  const { options, options_display: display, disclosure_block: block } = props;
  // A card is never printed without its payment, term, APR and TILA box: if either list misses an option, no card is.
  if (!displayCovers(options.options, display) || !disclosureCovers(options.options, block)) {
    return (
      <p className="homeowner-empty" role="alert">
        {UNREADABLE_REPLY_MESSAGE}
      </p>
    );
  }
  return (
    <>
      <h1 className="homeowner-title">Your payment options</h1>
      <div className="option-cards">
        {orderByTerm(options.options).map((option) => {
          const cells = displayFor(display, option.product_id);
          if (cells === null) return null;
          return (
            <article key={option.product_id} className="option-card" aria-labelledby={`card-${option.product_id}`}>
              <header>
                <h2 id={`card-${option.product_id}`}>{option.label}</h2>
                <p className="card-product">{option.product_name}</p>
              </header>
              <p className="card-payment">{cells.payment_text}</p>
              <p className="card-estimate">{block.estimate_statement}</p>
              <dl className="card-terms">
                <div>
                  <dt>Term</dt>
                  <dd>{cells.term_text}</dd>
                </div>
                <div>
                  <dt>APR</dt>
                  <dd>{cells.apr_text}</dd>
                </div>
              </dl>
              <p className="card-mechanic">{props.mechanic_sentences[option.product_id]}</p>
              <DisclosureBlockView block={block} productId={option.product_id} />
            </article>
          );
        })}
      </div>
      <section className="homeowner-section">
        <h2>How these options compare</h2>
        <p className="homeowner-explanation">{props.explanation}</p>
      </section>
      <p className="homeowner-respa">{block.respa_line}</p>
      <section className="homeowner-section next">
        <h2>What happens next</h2>
        <p>{props.what_happens_next}</p>
      </section>
    </>
  );
}
