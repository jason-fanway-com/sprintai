import { Save } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

interface Shop {
  id: string
  name: string
  timezone: string
  email_ticket_recipient: string | null
  pause_message: string | null
  phone_number_e164: string | null
}

interface SettingsTabProps {
  shop: Shop
  editingShop: boolean
  shopForm: Partial<Shop>
  onEditChange: (editing: boolean) => void
  onFormChange: (field: keyof Shop, value: any) => void
  onFormReset: () => void
  onSave: UseMutationResult<void, Error, void, unknown>
}

export default function SettingsTab({
  shop,
  editingShop,
  shopForm,
  onEditChange,
  onFormChange,
  onFormReset,
  onSave,
}: SettingsTabProps) {
  return (
    <div className="space-y-6 max-w-lg">
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-semibold text-gray-900">Shop Settings</h3>
          {!editingShop ? (
            <button onClick={() => onEditChange(true)} className="text-sm text-brand-600 hover:text-brand-700">
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onEditChange(false)
                  onFormReset()
                }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => onSave.mutate()}
                disabled={onSave.isPending}
                className="flex items-center gap-1 text-sm text-white bg-brand-600 px-3 py-1 rounded-lg hover:bg-brand-700 transition-colors"
              >
                <Save className="w-3 h-3" />
                Save
              </button>
            </div>
          )}
        </div>
        <div className="space-y-4">
          {[
            { label: 'Shop Name', field: 'name' as const },
            { label: 'Timezone', field: 'timezone' as const },
            { label: 'Order Email Recipient', field: 'email_ticket_recipient' as const },
            { label: 'Pause Message', field: 'pause_message' as const },
          ].map(({ label, field }) => (
            <div key={field}>
              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
              {editingShop ? (
                <input
                  value={(shopForm[field] ?? '') as string}
                  onChange={e => onFormChange(field, e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm text-gray-700">{(shop[field] ?? '') as string || <span className="text-gray-300">Not set</span>}</p>
              )}
            </div>
          ))}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Phone Number (SMS)</label>
            <p className="text-sm text-gray-700">{shop.phone_number_e164 ?? <span className="text-gray-300">Not configured</span>}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Shop ID</label>
            <p className="text-xs font-mono text-gray-400">{shop.id}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
