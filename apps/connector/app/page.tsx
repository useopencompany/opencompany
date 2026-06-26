const principles = ["Small MVP surface", "Separate product boundary", "Ready for runconnector.com"];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-16 sm:px-8">
        <div className="max-w-2xl">
          <p className="mb-4 text-sm font-medium text-muted-foreground">OpenCompany experiment</p>
          <h1 className="text-5xl font-semibold tracking-normal text-foreground sm:text-7xl">
            Connector
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
            A focused workspace for building the Connector MVP before it moves to its own
            runconnector.com deployment.
          </p>
        </div>

        <div className="mt-12 grid gap-3 sm:grid-cols-3">
          {principles.map((principle) => (
            <div key={principle} className="rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-medium text-card-foreground">{principle}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
