import type { SVGProps } from "react";

// Small inline icons for the navigation, the assistant panel and the cards. All are decorative
// (aria-hidden): the text beside each one carries the name.

type IconProps = SVGProps<SVGSVGElement>;

function Stroke({ children, ...props }: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** The contractor's application form. */
export function FormIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M9 4h6M8 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1" />
      <rect x="8.5" y="2.5" width="7" height="3.5" rx="1.2" />
      <path d="M9 11h6M9 15h6M9 19h3" />
    </Stroke>
  );
}

/** The reviewer's checked document. */
export function DocumentCheckIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="m9 14.2 2.2 2.2 3.9-4.2" />
    </Stroke>
  );
}

/** The audit trail. */
export function ListIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

/** A page of paper, for a review task. */
export function DocumentIcon(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Stroke>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Stroke width="16" height="16" strokeWidth="2.2" {...props}>
      <path d="m9 5 7 7-7 7" />
    </Stroke>
  );
}

/** The arrow on the send button. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Stroke width="18" height="18" strokeWidth="2.2" {...props}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </Stroke>
  );
}

/** The assistant's sparkle: one large star and two small ones. */
export function SparkleIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M10 3c.7 5.6 3.4 8.3 9 9-5.6.7-8.3 3.4-9 9-.7-5.6-3.4-8.3-9-9 5.6-.7 8.3-3.4 9-9z" />
      <path d="M19 2c.25 2 1 2.75 3 3-2 .25-2.75 1-3 3-.25-2-1-2.75-3-3 2-.25 2.75-1 3-3z" />
    </svg>
  );
}
