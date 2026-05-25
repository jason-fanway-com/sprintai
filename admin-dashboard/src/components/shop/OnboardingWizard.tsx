import { useState } from 'react'
import { Globe, Upload, MessageSquare, CheckCircle, ChevronRight } from 'lucide-react'

interface OnboardingWizardProps {
  websiteUrl: string
  hasContext: boolean
  hasMenuItems: boolean
  hasInstructions: boolean
  isScraping: boolean
  isUploading: boolean
  urlDraft: string
  instructionsDraft: string
  onUrlDraftChange: (v: string) => void
  onInstructionsDraftChange: (v: string) => void
  onScrape: () => void
  onUploadPdf: (e: React.ChangeEvent<HTMLInputElement>) => void
  onSave: () => void
  onSkip: () => void
}

export default function OnboardingWizard({
  hasContext,
  hasMenuItems,
  hasInstructions,
  isScraping,
  isUploading,
  urlDraft,
  instructionsDraft,
  onUrlDraftChange,
  onInstructionsDraftChange,
  onScrape,
  onUploadPdf,
  onSave,
  onSkip,
}: OnboardingWizardProps) {
  const steps = [
    { label: 'Add your website', done: hasContext, icon: Globe },
    { label: 'Upload your menu', done: hasMenuItems, icon: Upload },
    { label: 'Add instructions', done: hasInstructions, icon: MessageSquare, optional: true },
  ]
  const completed = steps.filter(s => s.done).length
  const allRequired = hasContext && hasMenuItems

  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <div className="text-center mb-8">
        <h2 className="text-xl font-bold text-gray-900">Set up your shop</h2>
        <p className="text-sm text-gray-500 mt-1">{completed} of {steps.length} complete</p>
        <div className="w-full bg-gray-200 rounded-full h-2 mt-3">
          <div
            className="bg-brand-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${(completed / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="space-y-4">
        {/* Step 1: Website */}
        <div className={`rounded-xl border p-4 ${hasContext ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center gap-3 mb-2">
            {hasContext ? <CheckCircle className="w-5 h-5 text-green-500" /> : <Globe className="w-5 h-5 text-gray-400" />}
            <span className="font-medium text-sm">{steps[0].label}</span>
          </div>
          {!hasContext && (
            <div className="flex gap-2 mt-2">
              <input
                type="url"
                value={urlDraft}
                onChange={e => onUrlDraftChange(e.target.value)}
                placeholder="https://yourrestaurant.com"
                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                onClick={onScrape}
                disabled={isScraping || !urlDraft.trim()}
                className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
              >
                {isScraping ? 'Scraping...' : 'Scrape'}
              </button>
            </div>
          )}
        </div>

        {/* Step 2: Menu PDF */}
        <div className={`rounded-xl border p-4 ${hasMenuItems ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center gap-3 mb-2">
            {hasMenuItems ? <CheckCircle className="w-5 h-5 text-green-500" /> : <Upload className="w-5 h-5 text-gray-400" />}
            <span className="font-medium text-sm">{steps[1].label}</span>
          </div>
          {!hasMenuItems && (
            <label className={`inline-flex items-center gap-2 mt-2 px-4 py-2 text-sm rounded-lg cursor-pointer transition-colors ${isUploading ? 'bg-gray-400' : 'bg-brand-600 hover:bg-brand-700'} text-white`}>
              {isUploading ? 'Parsing...' : 'Upload PDF'}
              <input type="file" accept=".pdf" className="hidden" onChange={onUploadPdf} disabled={isUploading} />
            </label>
          )}
        </div>

        {/* Step 3: Instructions (optional) */}
        <div className={`rounded-xl border p-4 ${hasInstructions ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center gap-3 mb-2">
            {hasInstructions ? <CheckCircle className="w-5 h-5 text-green-500" /> : <MessageSquare className="w-5 h-5 text-gray-400" />}
            <span className="font-medium text-sm">{steps[2].label} <span className="text-gray-400 text-xs">(optional)</span></span>
          </div>
          {!hasInstructions && (
            <div className="mt-2 space-y-2">
              <textarea
                value={instructionsDraft}
                onChange={e => onInstructionsDraftChange(e.target.value)}
                rows={3}
                placeholder="Example: When a customer orders a dozen bagels, ask them what kinds they want."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              />
              <button
                onClick={onSave}
                disabled={!instructionsDraft.trim()}
                className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
              >
                Save Instructions
              </button>
            </div>
          )}
        </div>
      </div>

      {allRequired && (
        <div className="text-center mt-8">
          <button
            onClick={onSkip}
            className="px-6 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
          >
            Setup complete — go to full view →
          </button>
        </div>
      )}

      <div className="text-center mt-4">
        <button onClick={onSkip} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
          Skip setup
        </button>
      </div>
    </div>
  )
}
