import { useNavigate } from 'react-router-dom'
import { MessageSquare, ArrowRight } from 'lucide-react'

export default function ChatTest() {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-8">
      <MessageSquare className="w-10 h-10 text-gray-300 mb-4" />
      <p className="text-gray-600 font-medium mb-1">Chat Test is now inside each shop</p>
      <p className="text-sm text-gray-400 mb-4">
        Select a shop from the Shops page, then open the Chat Test tab.
      </p>
      <button
        onClick={() => navigate('/shops')}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
      >
        Go to Shops
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  )
}
