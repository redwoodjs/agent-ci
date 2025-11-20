import type { LayoutProps } from "rwsdk/router";

export function AuditLayout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <a href="/" className="text-xl font-bold">
                  Machinen
                </a>
              </div>
              <div className="ml-6 flex space-x-8">
                <a
                  href="/audit"
                  className="inline-flex items-center px-1 pt-1 border-b-2 border-blue-500 text-sm font-medium"
                >
                  Dashboard
                </a>
                <a
                  href="/audit/ingestion"
                  className="inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300"
                >
                  Ingestion
                </a>
                <a
                  href="/audit/indexing"
                  className="inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300"
                >
                  Indexing
                </a>
              </div>
            </div>
          </div>
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}

