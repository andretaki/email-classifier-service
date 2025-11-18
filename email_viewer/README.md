# Email Classifier Viewer

Elegant Ruby web interface for viewing and responding to flagged emails from the email classifier system.

## Features

### ✨ Outlook-Inspired Design
- Clean, professional interface matching Microsoft Outlook aesthetics
- Responsive layout with familiar email list and detail views
- Intuitive navigation and visual cues

### 🚩 Email Management
- **View flagged emails**: Browse all emails flagged by the classifier
- **Email previews**: Quick preview of email content in the list view
- **Detailed view**: Full email content with response history
- **Response status**: Visual indicators for responded/pending emails

### 🤖 AI-Powered Responses
- **Generate Response**: One-click AI response generation using Google Gemini
- **Edit & Send**: Review and edit generated responses before sending
- **Professional tone**: World-class prompts for customer service excellence
- **Alliance Chemical context**: Industry-specific, professional responses

### 📊 Response Tracking
- **Mark as handled**: Track which emails have been addressed
- **Response history**: View response times and categories
- **Learning loop**: Feeds back into the classifier for continuous improvement

## Setup

### 1. Install Dependencies
```bash
cd email_viewer
bundle install
```

### 2. Environment Variables
Create `.env` file:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=email_classifier
DB_USER=postgres
DB_PASSWORD=your_password

GOOGLE_API_KEY=your_google_api_key
MS_GRAPH_ACCESS_TOKEN=your_microsoft_graph_token
```

### 3. Run the Application
```bash
# Development
bundle exec rackup -p 4567

# Production
bundle exec puma -p 4567
```

Visit `http://localhost:4567` to view flagged emails.

## Architecture

### Simple & Elegant
- **Sinatra framework**: Lightweight, fast Ruby web app
- **PostgreSQL connection**: Direct database queries, no ORM complexity
- **RESTful API**: Clean endpoints for email operations
- **Vanilla JavaScript**: No heavy frameworks, fast loading

### Database Integration
- **Existing tables**: Uses your current email_classifier database
- **Feedback loop**: Updates email_feedback table for learning
- **Response tracking**: Seamless integration with existing system

### Expandable Foundation
- **Modular design**: Easy to add new features
- **API-first**: Frontend and backend cleanly separated  
- **Future-ready**: Built for agentic AI expansion

## API Endpoints

- `GET /` - Email list view
- `GET /email/:message_id` - Email detail view
- `GET /api/emails` - JSON API for email list
- `POST /api/generate-response/:message_id` - Generate AI response
- `POST /api/send-response` - Send email response
- `POST /api/mark-handled/:message_id` - Mark email as handled

## File Structure
```
email_viewer/
├── app.rb                 # Main Sinatra application
├── config.ru             # Rack configuration
├── Gemfile               # Ruby dependencies
├── app/
│   └── views/
│       ├── layout.erb    # Main HTML layout
│       ├── index.erb     # Email list view
│       └── email_detail.erb  # Email detail view
└── README.md
```

## Next Steps

### Phase 1: Enhanced UI
- Real-time updates with WebSockets
- Better email formatting and attachments
- Search and filtering capabilities

### Phase 2: Advanced AI
- Context-aware response generation
- Customer history integration
- Sentiment analysis and priority scoring

### Phase 3: Full Automation
- Automatic response sending for simple queries
- Escalation rules for complex issues
- Performance analytics and reporting

**Built for elegance, designed for expansion. The foundation for world-class customer service automation.**