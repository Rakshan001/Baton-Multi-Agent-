export default function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  intro?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`mx-auto max-w-7xl px-5 py-24 lg:py-32 ${className}`}
      aria-labelledby={id ? `${id}-title` : undefined}
    >
      {(eyebrow || title) && (
        <div className="mb-14 max-w-2xl">
          {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
          {title && (
            <h2
              id={id ? `${id}-title` : undefined}
              className="text-display text-balance text-3xl sm:text-4xl lg:text-5xl"
            >
              {title}
            </h2>
          )}
          {intro && (
            <p className="mt-5 text-pretty text-lg leading-relaxed text-muted">
              {intro}
            </p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
