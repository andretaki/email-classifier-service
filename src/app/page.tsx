export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 w-full max-w-5xl items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold text-center mb-8 text-alliance-blue">
          Alliance Chemical RAG System
        </h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
          <div className="border border-gray-300 rounded-lg p-6 hover:shadow-lg transition-shadow">
            <h2 className="text-xl font-semibold mb-4 text-alliance-blue">
              Product Search
            </h2>
            <p className="text-gray-600">
              Hybrid search combining BM25 lexical matching with vector semantic search for accurate product discovery.
            </p>
          </div>
          
          <div className="border border-gray-300 rounded-lg p-6 hover:shadow-lg transition-shadow">
            <h2 className="text-xl font-semibold mb-4 text-alliance-blue">
              Quote Generation
            </h2>
            <p className="text-gray-600">
              Deterministic pricing tools with container size variations and volume discounts.
            </p>
          </div>
          
          <div className="border border-gray-300 rounded-lg p-6 hover:shadow-lg transition-shadow">
            <h2 className="text-xl font-semibold mb-4 text-alliance-blue">
              Analytics
            </h2>
            <p className="text-gray-600">
              Search analytics and customer query insights to improve product recommendations.
            </p>
          </div>
        </div>
        
        <div className="mt-12 text-center">
          <p className="text-gray-500">
            System Status: <span className="text-green-600 font-semibold">Database Schema Created</span>
          </p>
        </div>
      </div>
    </main>
  )
}