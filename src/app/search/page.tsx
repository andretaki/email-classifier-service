'use client';

import { useState } from 'react';
import type { AllianceProduct } from '@/types';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<AllianceProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const [filters, setFilters] = useState({
    product_type: '',
    hazmat: false,
    in_stock: false,
    max_price: '',
    container_size: '',
  });

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          filters: {
            ...(filters.product_type && { product_type: filters.product_type }),
            ...(filters.hazmat && { hazmat: filters.hazmat }),
            ...(filters.in_stock && { in_stock: filters.in_stock }),
            ...(filters.max_price && { max_price: parseFloat(filters.max_price) }),
            ...(filters.container_size && { container_size: filters.container_size }),
          },
        }),
      });

      if (!response.ok) throw new Error('Search failed');
      
      const data = await response.json();
      setProducts(data.products || []);
      setSearchTime(data.search_time_ms);
    } catch (error) {
      console.error('Search error:', error);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-alliance-blue mb-8">
          Alliance Chemical Product Search
        </h1>

        {/* Search Form */}
        <form onSubmit={handleSearch} className="bg-white shadow-md rounded-lg p-6 mb-8">
          <div className="mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by product name, CAS number, or description..."
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-alliance-blue focus:border-transparent"
            />
          </div>

          {/* Filters */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
            <select
              value={filters.product_type}
              onChange={(e) => setFilters({ ...filters, product_type: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All Types</option>
              <option value="Acids">Acids</option>
              <option value="Bases">Bases</option>
              <option value="Solvents">Solvents</option>
              <option value="Glycols">Glycols</option>
              <option value="Salts">Salts</option>
            </select>

            <select
              value={filters.container_size}
              onChange={(e) => setFilters({ ...filters, container_size: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All Sizes</option>
              <option value="1 Gallon">1 Gallon</option>
              <option value="5 Gallons">5 Gallons</option>
              <option value="55 Gallons">55 Gallons</option>
              <option value="275 Gallons">275 Gallon Tote</option>
            </select>

            <input
              type="number"
              value={filters.max_price}
              onChange={(e) => setFilters({ ...filters, max_price: e.target.value })}
              placeholder="Max price"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />

            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={filters.hazmat}
                onChange={(e) => setFilters({ ...filters, hazmat: e.target.checked })}
                className="rounded text-alliance-blue"
              />
              <span className="text-sm">Hazmat Only</span>
            </label>

            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={filters.in_stock}
                onChange={(e) => setFilters({ ...filters, in_stock: e.target.checked })}
                className="rounded text-alliance-blue"
              />
              <span className="text-sm">In Stock</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-alliance-blue text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors"
          >
            {loading ? 'Searching...' : 'Search Products'}
          </button>
        </form>

        {/* Search Results */}
        {searchTime !== null && (
          <p className="text-sm text-gray-600 mb-4">
            Found {products.length} products in {searchTime}ms using hybrid search (BM25 + Vector)
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.map((product) => (
            <div key={product.id} className="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                {product.title}
              </h2>
              
              <div className="space-y-2 text-sm text-gray-600">
                {product.cas_number && (
                  <p><span className="font-medium">CAS:</span> {product.cas_number}</p>
                )}
                {product.un_number && (
                  <p><span className="font-medium">UN:</span> {product.un_number}</p>
                )}
                {product.hazard_class && (
                  <p className="text-red-600">
                    <span className="font-medium">Hazard:</span> {product.hazard_class}
                  </p>
                )}
                {product.product_type && (
                  <p><span className="font-medium">Type:</span> {product.product_type}</p>
                )}
                
                {product.container_sizes && product.container_sizes.length > 0 && (
                  <div>
                    <span className="font-medium">Sizes:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {product.container_sizes.slice(0, 4).map((size, idx) => (
                        <span key={idx} className="bg-gray-100 px-2 py-1 rounded text-xs">
                          {size}
                        </span>
                      ))}
                      {product.container_sizes.length > 4 && (
                        <span className="text-xs text-gray-500">
                          +{product.container_sizes.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                )}
                
                {product.min_price && (
                  <p className="text-green-600 font-semibold">
                    Starting at ${product.min_price.toFixed(2)}
                  </p>
                )}
                
                <div className="flex items-center justify-between mt-3">
                  <span className={`text-xs px-2 py-1 rounded ${
                    product.in_stock ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {product.in_stock ? 'In Stock' : 'Out of Stock'}
                  </span>
                  
                  {product.relevance_score && (
                    <span className="text-xs text-gray-500">
                      Score: {(product.relevance_score * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {products.length === 0 && !loading && searchTime !== null && (
          <div className="text-center py-12 text-gray-500">
            No products found. Try adjusting your search or filters.
          </div>
        )}
      </div>
    </div>
  );
}