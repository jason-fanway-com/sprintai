import type { ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import ConversationalAdminChat from './ConversationalAdminChat'

/** The owner's "talk to your shop" chat, in the same phone frame as "Test your assistant" (Jason 2026-10-05). */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex flex-col bg-[#1a1a1a] rounded-[40px] p-3 shadow-2xl">
      <div className="bg-white rounded-[32px] overflow-hidden flex flex-col w-[300px] h-[580px] relative">{children}</div>
    </div>
  )
}

export default function OwnerChatPhone({ shopId, chat }: { shopId: string; chat?: ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden lg:sticky lg:top-6">
      <div className="bg-brand-50 border-b border-brand-100 px-4 py-2.5 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-brand-600" />
        <span className="text-sm font-semibold text-gray-900">Talk to your shop</span>
      </div>
      <div className="px-4 py-2 border-b border-brand-100">
        <p className="text-xs text-gray-600">Change the menu, 86 an item, pause delivery or close for the day. Just say it.</p>
      </div>
      <div className="flex justify-center py-4">
        <PhoneFrame>{chat ?? <ConversationalAdminChat shopId={shopId} />}</PhoneFrame>
      </div>
    </div>
  )
}
