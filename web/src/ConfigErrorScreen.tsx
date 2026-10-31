/** Shown instead of the app when it is misconfigured, so the page is never blank. */
export function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12">
      <div role="alert" className="rounded-lg border border-status-r bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-status-r">OpsVision cannot start</h1>
        <p className="mt-3 text-sm">{message}</p>
      </div>
    </main>
  )
}
