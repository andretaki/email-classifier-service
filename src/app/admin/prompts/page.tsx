'use client';

import { useState, useEffect } from 'react';

interface PromptTemplate {
  id: number;
  name: string;
  category: string;
  description: string;
  template_text: string;
  system_prompt: string;
  required_variables: string[];
  optional_variables: string[];
  is_active: boolean;
  is_default: boolean;
  usage_count: number;
  success_rate: number | null;
  version: number;
}

interface TestResult {
  rendered: string;
  error?: string;
}

export default function PromptAdminPage() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'list' | 'edit' | 'test' | 'feedback'>('list');

  // Fetch all templates
  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const response = await fetch('/api/admin/prompts');
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  };

  const handleSaveTemplate = async () => {
    if (!selectedTemplate) return;

    setLoading(true);
    try {
      const method = selectedTemplate.id ? 'PUT' : 'POST';
      const url = selectedTemplate.id 
        ? `/api/admin/prompts/${selectedTemplate.id}`
        : '/api/admin/prompts';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedTemplate),
      });

      if (response.ok) {
        await fetchTemplates();
        setEditMode(false);
        alert('Template saved successfully!');
      } else {
        alert('Failed to save template');
      }
    } catch (error) {
      console.error('Error saving template:', error);
      alert('Error saving template');
    } finally {
      setLoading(false);
    }
  };

  const handleTestTemplate = async () => {
    if (!selectedTemplate) return;

    setLoading(true);
    try {
      const response = await fetch('/api/admin/prompts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: selectedTemplate.template_text,
          variables: testVariables,
        }),
      });

      const data = await response.json();
      setTestResult(data);
    } catch (error) {
      console.error('Error testing template:', error);
      setTestResult({ rendered: '', error: 'Failed to test template' });
    } finally {
      setLoading(false);
    }
  };

  const categoryColors: Record<string, string> = {
    quote_request: 'bg-blue-100 text-blue-800',
    order_status: 'bg-green-100 text-green-800',
    product_inquiry: 'bg-purple-100 text-purple-800',
    general: 'bg-gray-100 text-gray-800',
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">
          Prompt Template Management
        </h1>

        {/* Tab Navigation */}
        <div className="flex space-x-4 mb-6 border-b">
          {(['list', 'edit', 'test', 'feedback'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'text-alliance-blue border-b-2 border-alliance-blue'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {tab === 'list' ? 'Templates' : tab}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Template List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold">Templates</h2>
                <button
                  onClick={() => {
                    setSelectedTemplate({
                      id: 0,
                      name: 'New Template',
                      category: 'general',
                      description: '',
                      template_text: '',
                      system_prompt: '',
                      required_variables: [],
                      optional_variables: [],
                      is_active: true,
                      is_default: false,
                      usage_count: 0,
                      success_rate: null,
                      version: 1,
                    });
                    setEditMode(true);
                    setActiveTab('edit');
                  }}
                  className="px-3 py-1 bg-alliance-blue text-white rounded hover:bg-blue-700"
                >
                  + New
                </button>
              </div>

              <div className="space-y-2">
                {templates.map((template) => (
                  <div
                    key={template.id}
                    onClick={() => {
                      setSelectedTemplate(template);
                      setEditMode(false);
                    }}
                    className={`p-3 border rounded cursor-pointer hover:bg-gray-50 ${
                      selectedTemplate?.id === template.id ? 'border-alliance-blue bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="font-medium text-sm">{template.name}</h3>
                      <span className={`text-xs px-2 py-1 rounded ${categoryColors[template.category] || 'bg-gray-100'}`}>
                        {template.category}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mb-2">{template.description}</p>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">v{template.version}</span>
                      <div className="flex gap-2">
                        {template.is_default && (
                          <span className="text-green-600">Default</span>
                        )}
                        {template.usage_count > 0 && (
                          <span className="text-gray-500">
                            {template.usage_count} uses
                          </span>
                        )}
                        {template.success_rate && (
                          <span className="text-gray-500">
                            {template.success_rate}% success
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Template Editor/Viewer */}
          <div className="lg:col-span-2">
            {selectedTemplate && (
              <div className="bg-white rounded-lg shadow p-6">
                {activeTab === 'edit' && (
                  <>
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-semibold">
                        {editMode ? 'Edit Template' : 'Template Details'}
                      </h2>
                      <div className="flex gap-2">
                        {!editMode ? (
                          <button
                            onClick={() => setEditMode(true)}
                            className="px-4 py-2 bg-alliance-blue text-white rounded hover:bg-blue-700"
                          >
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={handleSaveTemplate}
                              disabled={loading}
                              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditMode(false)}
                              className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Name
                        </label>
                        <input
                          type="text"
                          value={selectedTemplate.name}
                          onChange={(e) => setSelectedTemplate({
                            ...selectedTemplate,
                            name: e.target.value,
                          })}
                          disabled={!editMode}
                          className="w-full px-3 py-2 border rounded-lg disabled:bg-gray-100"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Category
                          </label>
                          <select
                            value={selectedTemplate.category}
                            onChange={(e) => setSelectedTemplate({
                              ...selectedTemplate,
                              category: e.target.value,
                            })}
                            disabled={!editMode}
                            className="w-full px-3 py-2 border rounded-lg disabled:bg-gray-100"
                          >
                            <option value="quote_request">Quote Request</option>
                            <option value="order_status">Order Status</option>
                            <option value="product_inquiry">Product Inquiry</option>
                            <option value="general">General</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Version
                          </label>
                          <input
                            type="number"
                            value={selectedTemplate.version}
                            onChange={(e) => setSelectedTemplate({
                              ...selectedTemplate,
                              version: parseInt(e.target.value),
                            })}
                            disabled={!editMode}
                            className="w-full px-3 py-2 border rounded-lg disabled:bg-gray-100"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Description
                        </label>
                        <textarea
                          value={selectedTemplate.description}
                          onChange={(e) => setSelectedTemplate({
                            ...selectedTemplate,
                            description: e.target.value,
                          })}
                          disabled={!editMode}
                          rows={2}
                          className="w-full px-3 py-2 border rounded-lg disabled:bg-gray-100"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Template Text
                          <span className="ml-2 text-xs text-gray-500">
                            Use {"{{variable}}"} for variables, {"{{#if condition}}"} for conditionals
                          </span>
                        </label>
                        <textarea
                          value={selectedTemplate.template_text}
                          onChange={(e) => setSelectedTemplate({
                            ...selectedTemplate,
                            template_text: e.target.value,
                          })}
                          disabled={!editMode}
                          rows={10}
                          className="w-full px-3 py-2 border rounded-lg font-mono text-sm disabled:bg-gray-100"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          System Prompt (AI Instructions)
                        </label>
                        <textarea
                          value={selectedTemplate.system_prompt}
                          onChange={(e) => setSelectedTemplate({
                            ...selectedTemplate,
                            system_prompt: e.target.value,
                          })}
                          disabled={!editMode}
                          rows={3}
                          className="w-full px-3 py-2 border rounded-lg disabled:bg-gray-100"
                        />
                      </div>

                      <div className="flex gap-4">
                        <label className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedTemplate.is_active}
                            onChange={(e) => setSelectedTemplate({
                              ...selectedTemplate,
                              is_active: e.target.checked,
                            })}
                            disabled={!editMode}
                            className="mr-2"
                          />
                          Active
                        </label>
                        <label className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedTemplate.is_default}
                            onChange={(e) => setSelectedTemplate({
                              ...selectedTemplate,
                              is_default: e.target.checked,
                            })}
                            disabled={!editMode}
                            className="mr-2"
                          />
                          Default for Category
                        </label>
                      </div>
                    </div>
                  </>
                )}

                {activeTab === 'test' && (
                  <>
                    <h2 className="text-xl font-semibold mb-4">Test Template</h2>
                    
                    <div className="space-y-4">
                      <div className="bg-gray-50 p-4 rounded">
                        <h3 className="font-medium mb-2">Template Variables</h3>
                        <div className="space-y-2">
                          {[...selectedTemplate.required_variables, ...selectedTemplate.optional_variables].map((variable) => (
                            <div key={variable}>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                {variable} {selectedTemplate.required_variables.includes(variable) && '*'}
                              </label>
                              <input
                                type="text"
                                value={testVariables[variable] || ''}
                                onChange={(e) => setTestVariables({
                                  ...testVariables,
                                  [variable]: e.target.value,
                                })}
                                className="w-full px-3 py-2 border rounded"
                                placeholder={`Enter ${variable}`}
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      <button
                        onClick={handleTestTemplate}
                        disabled={loading}
                        className="w-full px-4 py-2 bg-alliance-blue text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
                      >
                        {loading ? 'Testing...' : 'Test Template'}
                      </button>

                      {testResult && (
                        <div className="bg-white border rounded p-4">
                          <h3 className="font-medium mb-2">Test Result:</h3>
                          {testResult.error ? (
                            <div className="text-red-600">{testResult.error}</div>
                          ) : (
                            <div className="whitespace-pre-wrap">{testResult.rendered}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {activeTab === 'feedback' && (
                  <>
                    <h2 className="text-xl font-semibold mb-4">Template Feedback</h2>
                    <p className="text-gray-600">
                      Feedback history for this template will be displayed here.
                    </p>
                    {/* TODO: Add feedback history component */}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}