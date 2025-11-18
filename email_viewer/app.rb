require 'sinatra'
require 'pg'
require 'json'
require 'erb'
require 'time'

class EmailViewer < Sinatra::Base
  configure do
    set :views, File.join(File.dirname(__FILE__), 'app', 'views')
    set :public_folder, File.join(File.dirname(__FILE__), 'public')
  end

  def db_connection
    puts "DATABASE_URL: #{ENV['DATABASE_URL']}" if ENV['DATABASE_URL']
    puts "All ENV vars starting with 'DATABASE': #{ENV.select { |k,v| k.start_with?('DATABASE') }}"
    
    database_url = ENV['DATABASE_URL']
    if database_url.nil? || database_url.empty?
      raise "DATABASE_URL environment variable is not set"
    end
    
    @db ||= PG.connect(database_url)
  end

  get '/' do
    @emails = get_flagged_emails
    erb :index
  end

  get '/email/:message_id' do
    @email = get_email_details(params[:message_id])
    erb :email_detail
  end

  get '/api/emails' do
    content_type :json
    get_flagged_emails.to_json
  end

  post '/api/generate-response/:message_id' do
    content_type :json
    
    # Parse request body to get user context
    request_body = JSON.parse(request.body.read) rescue {}
    user_context = request_body['user_context']
    
    email = get_email_details(params[:message_id])
    return { error: 'Email not found' }.to_json unless email
    
    # First check if we already have a draft response (skip cache if user provided context)
    if user_context.nil? || user_context.empty?
      draft = get_draft_response(params[:message_id])
      
      if draft && !params[:regenerate]
        return { 
          success: true, 
          response: draft[:draft_response],
          tools_used: draft[:tools_used],
          confidence: draft[:confidence_score],
          from_cache: true
        }.to_json
      end
    end
    
    # Call the Agent API with user context
    response = call_agent_api(email, user_context)
    
    # Store the new draft
    if response[:success]
      store_draft_response(params[:message_id], response[:message], response[:tools_used], response[:confidence])
    end
    
    { 
      success: response[:success], 
      response: response[:message],
      tools_used: response[:tools_used],
      confidence: response[:confidence],
      from_cache: false
    }.to_json
  end

  post '/api/mark-handled/:message_id' do
    content_type :json
    mark_as_handled(params[:message_id])
    { success: true }.to_json
  end

  post '/api/send-response' do
    content_type :json
    data = JSON.parse(request.body.read)
    
    result = send_email_response(
      data['message_id'], 
      data['response_text'],
      data['subject']
    )
    
    if result[:success]
      mark_as_handled(data['message_id'])
      { success: true }.to_json
    else
      { success: false, error: result[:error] }.to_json
    end
  end

  private

  def get_flagged_emails
    query = <<~SQL
      SELECT 
        message_id,
        sender_email,
        subject,
        COALESCE(body_preview, LEFT(COALESCE(error::text, ''), 200), 'No preview available') as preview,
        classification as flag_reason,
        processed_at as created_at
      FROM email_classifier_processed_emails 
      WHERE flagged = true 
      ORDER BY processed_at DESC 
      LIMIT 50
    SQL
    
    result = db_connection.exec(query)
    result.map do |row|
      {
        message_id: row['message_id'],
        sender_email: row['sender_email'],
        sender_name: row['sender_email'], # Use email as name for now
        subject: row['subject'],
        preview: row['preview'],
        flag_reason: row['flag_reason'],
        created_at: Time.parse(row['created_at']),
        responded: false # Will be updated via feedback table later
      }
    end
  end

  def get_email_details(message_id)
    query = <<~SQL
      SELECT 
        e.message_id,
        e.sender_email,
        e.subject,
        e.classification,
        e.error,
        e.processed_at,
        e.body_text,
        e.body_html,
        e.body_preview,
        e.ai_reasoning,
        e.ai_confidence,
        e.ai_factors,
        f.responded,
        f.days_to_response,
        f.response_category
      FROM email_classifier_processed_emails e
      LEFT JOIN email_feedback f ON e.message_id = f.message_id
      WHERE e.message_id = $1
    SQL
    
    result = db_connection.exec(query, [message_id])
    return nil if result.ntuples == 0
    
    row = result[0]
    
    # Get AI reasoning and confidence from dedicated columns
    ai_reasoning = row['ai_reasoning']
    ai_confidence = row['ai_confidence']&.to_f
    
    # Parse AI factors if available
    ai_factors = begin
      JSON.parse(row['ai_factors']) if row['ai_factors']
    rescue
      nil
    end
    
    
    # Format AI reasoning for display
    if ai_reasoning && ai_factors
      formatted_reasoning = "**Classification:** #{row['classification']}\n\n"
      formatted_reasoning += "**Reasoning:** #{ai_reasoning}\n\n"
      
      if ai_factors['senderHistory']
        history = ai_factors['senderHistory']
        formatted_reasoning += "**Sender History:** #{(history['responseRate'] * 100).round(1)}% response rate (#{history['priority']} priority)\n\n"
      end
      
      if ai_factors['hasAttachments']
        formatted_reasoning += "**Has Attachments:** Yes\n\n"
      end
      
      ai_reasoning = formatted_reasoning.strip
    end
    
    # Use stored email content, fallback to basic info if not available
    body_text = row['body_text']
    body_html = row['body_html']
    
    if body_text.nil? || body_text.empty?
      # Fallback content when body not stored
      body_text = "Email from: #{row['sender_email']}\nSubject: #{row['subject']}\nClassified as: #{row['classification']}\n\nEmail content not available in database.\nMessage ID: #{message_id}"
    end
    
    {
      message_id: row['message_id'],
      sender_email: row['sender_email'],
      sender_name: row['sender_email'], # Use email as name
      subject: row['subject'],
      body_text: body_text,
      body_html: body_html,
      flag_reason: row['classification'],
      created_at: Time.parse(row['processed_at']),
      responded: row['responded'] == 't',
      days_to_response: row['days_to_response'],
      response_category: row['response_category'],
      ai_reasoning: ai_reasoning,
      ai_confidence: ai_confidence
    }
  end

  def fetch_email_content(message_id)
    require 'net/http'
    require 'uri'
    
    # First, try to get a Microsoft Graph access token
    access_token = get_graph_access_token
    return { body_text: 'Unable to fetch email content - no access token' } unless access_token

    begin
      # Try shared mailbox endpoint first
      shared_mailbox = ENV['SHARED_MAILBOX_ADDRESS'] || 'sales@alliancechemical.com'
      uri = URI("https://graph.microsoft.com/v1.0/users/#{shared_mailbox}/messages/#{message_id}")
      
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = true
      request = Net::HTTP::Get.new(uri)
      request['Authorization'] = "Bearer #{access_token}"
      request['Content-Type'] = 'application/json'

      response = http.request(request)
      
      if response.code.to_i == 200
        email_data = JSON.parse(response.body)
        body_content = email_data['body']&.dig('content') || email_data['bodyPreview'] || 'No content available'
        
        {
          body_text: body_content.gsub(/<[^>]*>/, '').strip,
          body_html: body_content
        }
      elsif response.code.to_i == 404
        # Try fallback with /me endpoint
        fallback_uri = URI("https://graph.microsoft.com/v1.0/me/messages/#{message_id}")
        fallback_request = Net::HTTP::Get.new(fallback_uri)
        fallback_request['Authorization'] = "Bearer #{access_token}"
        fallback_request['Content-Type'] = 'application/json'
        
        fallback_response = http.request(fallback_request)
        if fallback_response.code.to_i == 200
          email_data = JSON.parse(fallback_response.body)
          body_content = email_data['body']&.dig('content') || email_data['bodyPreview'] || 'No content available'
          
          {
            body_text: body_content.gsub(/<[^>]*>/, '').strip,
            body_html: body_content
          }
        else
          { body_text: "Email not accessible (HTTP #{response.code})" }
        end
      else
        puts "Graph API Error: #{response.code} - #{response.body}"
        { body_text: "Unable to fetch email content (HTTP #{response.code})" }
      end
    rescue => e
      puts "Exception fetching email: #{e.message}"
      { body_text: "Error fetching email content: #{e.message}" }
    end
  end

  def get_graph_access_token
    require 'net/http'
    require 'uri'
    
    # Use client credentials flow to get access token
    tenant_id = ENV['MICROSOFT_GRAPH_TENANT_ID']
    client_id = ENV['MICROSOFT_GRAPH_CLIENT_ID']
    client_secret = ENV['MICROSOFT_GRAPH_CLIENT_SECRET']
    
    return nil unless tenant_id && client_id && client_secret
    
    begin
      uri = URI("https://login.microsoftonline.com/#{tenant_id}/oauth2/v2.0/token")
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = true
      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/x-www-form-urlencoded'
      
      request.body = URI.encode_www_form({
        'grant_type' => 'client_credentials',
        'client_id' => client_id,
        'client_secret' => client_secret,
        'scope' => 'https://graph.microsoft.com/.default'
      })

      response = http.request(request)
      
      if response.code.to_i == 200
        token_data = JSON.parse(response.body)
        token_data['access_token']
      else
        puts "Failed to get access token: #{response.code} #{response.body}"
        nil
      end
    rescue => e
      puts "Error getting access token: #{e.message}"
      nil
    end
  end

  def get_draft_response(message_id)
    query = <<~SQL
      SELECT 
        draft_response,
        tools_used,
        confidence_score,
        generated_at
      FROM email_response_drafts
      WHERE message_id = $1
        AND status != 'discarded'
      ORDER BY generated_at DESC
      LIMIT 1
    SQL
    
    result = db_connection.exec(query, [message_id])
    return nil if result.ntuples == 0
    
    row = result[0]
    {
      draft_response: row['draft_response'],
      tools_used: JSON.parse(row['tools_used'] || '[]'),
      confidence_score: row['confidence_score']&.to_f,
      generated_at: row['generated_at']
    }
  end
  
  def store_draft_response(message_id, response, tools_used, confidence)
    query = <<~SQL
      INSERT INTO email_response_drafts (
        message_id,
        sender_email,
        subject,
        draft_response,
        tools_used,
        confidence_score,
        generated_at,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'pending')
      ON CONFLICT (message_id) 
      DO UPDATE SET 
        draft_response = $4,
        tools_used = $5,
        confidence_score = $6,
        generated_at = NOW()
    SQL
    
    email = get_email_details(message_id)
    
    db_connection.exec(query, [
      message_id,
      email[:sender_email],
      email[:subject],
      response,
      tools_used.to_json,
      confidence
    ])
  end
  
  def call_agent_api(email, user_context = nil)
    require 'net/http'
    require 'uri'
    
    agent_url = ENV['AGENT_API_URL'] || 'http://localhost:3000/api/agent'
    
    begin
      uri = URI(agent_url)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      http.read_timeout = 30
      
      request = Net::HTTP::Post.new(uri.path, {
        'Content-Type' => 'application/json'
      })
      
      # Build message with user context if provided
      message = email[:body_text] || "Subject: #{email[:subject]}"
      if user_context && !user_context.empty?
        message = "#{message}\n\n[USER PROVIDED CONTEXT]: #{user_context}"
      end
      
      request.body = {
        message: message,
        context: {
          email_id: email[:message_id],
          customer_email: email[:sender_email],
          customer_name: email[:sender_email].split('@')[0],
          classification: email[:flag_reason],
          subject: email[:subject],
          user_provided_context: user_context
        }
      }.to_json
      
      response = http.request(request)
      
      if response.code == '200'
        data = JSON.parse(response.body)
        {
          success: true,
          message: data['message'],
          tools_used: data['tools_used'] || [],
          confidence: data['confidence'] || 0.5
        }
      else
        {
          success: false,
          message: "Failed to generate response: #{response.code}",
          tools_used: [],
          confidence: 0
        }
      end
    rescue => e
      puts "Agent API error: #{e.message}"
      {
        success: false,
        message: "Error calling Agent API: #{e.message}",
        tools_used: [],
        confidence: 0
      }
    end
  end

  def generate_ai_response(email)
    require 'net/http'
    require 'uri'
    
    prompt = <<~PROMPT
      You are a professional customer service representative for Alliance Chemical. 
      Generate a helpful, professional response to this customer email.
      
      Customer Email:
      From: #{email[:sender_name]} <#{email[:sender_email]}>
      Subject: #{email[:subject]}
      
      #{email[:body_text] || email[:body_html]}
      
      Please provide a professional, helpful response that addresses their inquiry.
      Include relevant product information if needed and maintain a friendly, professional tone.
      Keep the response concise but complete.
    PROMPT

    # Using OpenAI API with GPT-5 Nano
    uri = URI('https://api.openai.com/v1/chat/completions')
    
    request_body = {
      model: ENV['OPENAI_LLM_MODEL'] || 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a professional customer service representative for Alliance Chemical, a chemical supply company. Provide helpful, accurate, and professional responses to customer inquiries.'
        },
        {
          role: 'user', 
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    }

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    request = Net::HTTP::Post.new(uri)
    request['Content-Type'] = 'application/json'
    request['Authorization'] = "Bearer #{ENV['OPENAI_API_KEY']}"
    request.body = request_body.to_json

    begin
      response = http.request(request)
      result = JSON.parse(response.body)
      
      if result['choices'] && result['choices'][0] && result['choices'][0]['message']
        return result['choices'][0]['message']['content']
      else
        puts "OpenAI API Error: #{result}"
        return "Error generating response. Please draft manually. (#{result['error']&.dig('message') || 'Unknown error'})"
      end
    rescue => e
      puts "Exception calling OpenAI: #{e.message}"
      return "Error generating response: #{e.message}"
    end
  end

  def mark_as_handled(message_id)
    query = <<~SQL
      INSERT INTO email_feedback (message_id, flagged_at, responded, created_at)
      VALUES ($1, NOW(), true, NOW())
      ON CONFLICT (message_id) 
      DO UPDATE SET responded = true;
    SQL
    
    db_connection.exec(query, [message_id])
  end

  def send_email_response(message_id, response_text, subject)
    require 'net/http'
    require 'uri'
    
    # Get original email details
    email = get_email_details(message_id)
    return { success: false, error: 'Email not found' } unless email
    
    # Get access token using client credentials flow
    access_token = get_graph_access_token
    return { success: false, error: 'Unable to get access token' } unless access_token
    
    reply_subject = subject.start_with?('Re: ') ? subject : "Re: #{subject}"
    
    reply_body = {
      message: {
        subject: reply_subject,
        body: {
          contentType: 'Text',
          content: response_text
        },
        toRecipients: [
          {
            emailAddress: {
              address: email[:sender_email],
              name: email[:sender_name]
            }
          }
        ]
      }
    }

    # Use shared mailbox for sending replies
    shared_mailbox = ENV['SHARED_MAILBOX_ADDRESS'] || 'sales@alliancechemical.com'
    uri = URI("https://graph.microsoft.com/v1.0/users/#{shared_mailbox}/messages/#{message_id}/reply")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    request = Net::HTTP::Post.new(uri)
    request['Authorization'] = "Bearer #{access_token}"
    request['Content-Type'] = 'application/json'
    request.body = reply_body.to_json

    begin
      response = http.request(request)
      if response.code.to_i == 202
        { success: true }
      else
        { success: false, error: "Failed to send: #{response.code}" }
      end
    rescue => e
      { success: false, error: e.message }
    end
  end
end