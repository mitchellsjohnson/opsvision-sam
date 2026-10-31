import { Link } from 'react-router'
import { PlaceholderPage } from './Placeholder'

export function NotFoundPage() {
  return (
    <PlaceholderPage title="Page not found">
      <Link to="/" className="font-medium text-accent-deep underline">
        Go to the home page
      </Link>
    </PlaceholderPage>
  )
}
