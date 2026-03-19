export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          id: string
          ip_address: unknown
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          ip_address?: unknown
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      cms_pages: {
        Row: {
          body_md: string
          created_at: string
          id: string
          metadata: Json | null
          published_at: string | null
          slug: string
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          body_md: string
          created_at?: string
          id?: string
          metadata?: Json | null
          published_at?: string | null
          slug: string
          title: string
          updated_at?: string
          version?: number
        }
        Update: {
          body_md?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          published_at?: string | null
          slug?: string
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      compliance_audit_logs: {
        Row: {
          admin_id: string | null
          created_at: string
          description: string
          event_type: string
          id: string
          ip_address: unknown
          metadata: Json | null
          severity: string
          state_code: string | null
          user_id: string | null
        }
        Insert: {
          admin_id?: string | null
          created_at?: string
          description: string
          event_type: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          severity: string
          state_code?: string | null
          user_id?: string | null
        }
        Update: {
          admin_id?: string | null
          created_at?: string
          description?: string
          event_type?: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          severity?: string
          state_code?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      contest_entries: {
        Row: {
          contest_template_id: string
          created_at: string
          entry_fee_cents: number
          id: string
          instance_id: string | null
          margin_error: number | null
          payout_cents: number | null
          picks: Json
          pool_id: string
          rank: number | null
          state_code: string | null
          status: string
          tier_name: string | null
          total_points: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          contest_template_id: string
          created_at?: string
          entry_fee_cents: number
          id?: string
          instance_id?: string | null
          margin_error?: number | null
          payout_cents?: number | null
          picks: Json
          pool_id: string
          rank?: number | null
          state_code?: string | null
          status?: string
          tier_name?: string | null
          total_points?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          contest_template_id?: string
          created_at?: string
          entry_fee_cents?: number
          id?: string
          instance_id?: string | null
          margin_error?: number | null
          payout_cents?: number | null
          picks?: Json
          pool_id?: string
          rank?: number | null
          state_code?: string | null
          status?: string
          tier_name?: string | null
          total_points?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contest_entries_contest_template_id_fkey"
            columns: ["contest_template_id"]
            isOneToOne: false
            referencedRelation: "contest_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contest_entries_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "contest_pools"
            referencedColumns: ["id"]
          },
        ]
      }
      contest_instances: {
        Row: {
          completed_at: string | null
          contest_template_id: string
          created_at: string
          current_entries: number
          entry_fee_cents: number
          id: string
          lock_time: string
          locked_at: string | null
          max_entries: number
          metadata: Json | null
          min_entries: number
          pool_number: string
          prize_pool_cents: number
          settled_at: string | null
          status: string
          tier_id: string
        }
        Insert: {
          completed_at?: string | null
          contest_template_id: string
          created_at?: string
          current_entries?: number
          entry_fee_cents: number
          id?: string
          lock_time: string
          locked_at?: string | null
          max_entries: number
          metadata?: Json | null
          min_entries?: number
          pool_number: string
          prize_pool_cents?: number
          settled_at?: string | null
          status?: string
          tier_id: string
        }
        Update: {
          completed_at?: string | null
          contest_template_id?: string
          created_at?: string
          current_entries?: number
          entry_fee_cents?: number
          id?: string
          lock_time?: string
          locked_at?: string | null
          max_entries?: number
          metadata?: Json | null
          min_entries?: number
          pool_number?: string
          prize_pool_cents?: number
          settled_at?: string | null
          status?: string
          tier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contest_instances_contest_template_id_fkey"
            columns: ["contest_template_id"]
            isOneToOne: false
            referencedRelation: "contest_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      contest_pool_crews: {
        Row: {
          contest_pool_id: string
          created_at: string
          crew_id: string
          crew_name: string
          event_id: string
          id: string
          logo_url: string | null
          manual_finish_order: number | null
          manual_result_time: string | null
        }
        Insert: {
          contest_pool_id: string
          created_at?: string
          crew_id: string
          crew_name: string
          event_id: string
          id?: string
          logo_url?: string | null
          manual_finish_order?: number | null
          manual_result_time?: string | null
        }
        Update: {
          contest_pool_id?: string
          created_at?: string
          crew_id?: string
          crew_name?: string
          event_id?: string
          id?: string
          logo_url?: string | null
          manual_finish_order?: number | null
          manual_result_time?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contest_pool_crews_contest_pool_id_fkey"
            columns: ["contest_pool_id"]
            isOneToOne: false
            referencedRelation: "contest_pools"
            referencedColumns: ["id"]
          },
        ]
      }
      contest_pools: {
        Row: {
          allow_overflow: boolean
          contest_template_id: string
          created_at: string
          current_entries: number
          entry_fee_cents: number
          entry_tiers: Json | null
          id: string
          lock_time: string
          max_entries: number
          payout_structure: Json | null
          prize_pool_cents: number
          prize_structure: Json | null
          settled_at: string | null
          status: string
          tier_id: string
          winner_ids: string[] | null
        }
        Insert: {
          allow_overflow?: boolean
          contest_template_id: string
          created_at?: string
          current_entries?: number
          entry_fee_cents: number
          entry_tiers?: Json | null
          id?: string
          lock_time: string
          max_entries: number
          payout_structure?: Json | null
          prize_pool_cents: number
          prize_structure?: Json | null
          settled_at?: string | null
          status?: string
          tier_id: string
          winner_ids?: string[] | null
        }
        Update: {
          allow_overflow?: boolean
          contest_template_id?: string
          created_at?: string
          current_entries?: number
          entry_fee_cents?: number
          entry_tiers?: Json | null
          id?: string
          lock_time?: string
          max_entries?: number
          payout_structure?: Json | null
          prize_pool_cents?: number
          prize_structure?: Json | null
          settled_at?: string | null
          status?: string
          tier_id?: string
          winner_ids?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "contest_pools_contest_template_id_fkey"
            columns: ["contest_template_id"]
            isOneToOne: false
            referencedRelation: "contest_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      contest_scores: {
        Row: {
          created_at: string
          crew_scores: Json | null
          entry_id: string
          id: string
          instance_id: string | null
          is_tiebreak_resolved: boolean | null
          is_winner: boolean | null
          margin_bonus: number
          payout_cents: number | null
          pool_id: string | null
          rank: number | null
          total_points: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          crew_scores?: Json | null
          entry_id: string
          id?: string
          instance_id?: string | null
          is_tiebreak_resolved?: boolean | null
          is_winner?: boolean | null
          margin_bonus?: number
          payout_cents?: number | null
          pool_id?: string | null
          rank?: number | null
          total_points?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          crew_scores?: Json | null
          entry_id?: string
          id?: string
          instance_id?: string | null
          is_tiebreak_resolved?: boolean | null
          is_winner?: boolean | null
          margin_bonus?: number
          payout_cents?: number | null
          pool_id?: string | null
          rank?: number | null
          total_points?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contest_scores_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: true
            referencedRelation: "contest_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contest_scores_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "contest_pools"
            referencedColumns: ["id"]
          },
        ]
      }
      contest_templates: {
        Row: {
          created_at: string
          crews: Json
          divisions: Json
          entry_tiers: Json
          gender_category: string
          id: string
          lock_time: string
          max_picks: number
          min_picks: number
          regatta_name: string
          results: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          crews?: Json
          divisions?: Json
          entry_tiers?: Json
          gender_category: string
          id?: string
          lock_time: string
          max_picks?: number
          min_picks?: number
          regatta_name: string
          results?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          crews?: Json
          divisions?: Json
          entry_tiers?: Json
          gender_category?: string
          id?: string
          lock_time?: string
          max_picks?: number
          min_picks?: number
          regatta_name?: string
          results?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      feature_flags: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      geofence_logs: {
        Row: {
          action_type: string
          blocked_reason: string | null
          contest_id: string | null
          created_at: string
          gps_latitude: number | null
          gps_longitude: number | null
          id: string
          ip_address: unknown
          is_allowed: boolean
          metadata: Json | null
          state_detected: string | null
          user_id: string
          verification_method: string | null
          zip_code: string | null
        }
        Insert: {
          action_type: string
          blocked_reason?: string | null
          contest_id?: string | null
          created_at?: string
          gps_latitude?: number | null
          gps_longitude?: number | null
          id?: string
          ip_address?: unknown
          is_allowed: boolean
          metadata?: Json | null
          state_detected?: string | null
          user_id: string
          verification_method?: string | null
          zip_code?: string | null
        }
        Update: {
          action_type?: string
          blocked_reason?: string | null
          contest_id?: string | null
          created_at?: string
          gps_latitude?: number | null
          gps_longitude?: number | null
          id?: string
          ip_address?: unknown
          is_allowed?: boolean
          metadata?: Json | null
          state_detected?: string | null
          user_id?: string
          verification_method?: string | null
          zip_code?: string | null
        }
        Relationships: []
      }
      help_articles: {
        Row: {
          body_md: string
          category: string
          created_at: string
          id: string
          metadata: Json | null
          published_at: string | null
          slug: string
          tags: string[] | null
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          body_md: string
          category: string
          created_at?: string
          id?: string
          metadata?: Json | null
          published_at?: string | null
          slug: string
          tags?: string[] | null
          title: string
          updated_at?: string
          version?: number
        }
        Update: {
          body_md?: string
          category?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          published_at?: string | null
          slug?: string
          tags?: string[] | null
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      kyc_verifications: {
        Row: {
          created_at: string
          expires_at: string | null
          failure_reason: string | null
          id: string
          provider: string
          status: string
          updated_at: string
          user_id: string
          verification_data: Json | null
          verification_id: string | null
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          failure_reason?: string | null
          id?: string
          provider: string
          status?: string
          updated_at?: string
          user_id: string
          verification_data?: Json | null
          verification_id?: string | null
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          failure_reason?: string | null
          id?: string
          provider?: string
          status?: string
          updated_at?: string
          user_id?: string
          verification_data?: Json | null
          verification_id?: string | null
          verified_at?: string | null
        }
        Relationships: []
      }
      ledger_entries: {
        Row: {
          amount: number
          created_at: string
          description: string | null
          id: string
          reference_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          description?: string | null
          id?: string
          reference_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          reference_id?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      license_registry: {
        Row: {
          created_at: string
          expiry_date: string | null
          filing_fee: number | null
          id: string
          issued_date: string | null
          license_number: string | null
          license_type: string
          notes: string | null
          renewal_link: string | null
          report_due_date: string | null
          state_code: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expiry_date?: string | null
          filing_fee?: number | null
          id?: string
          issued_date?: string | null
          license_number?: string | null
          license_type?: string
          notes?: string | null
          renewal_link?: string | null
          report_due_date?: string | null
          state_code: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expiry_date?: string | null
          filing_fee?: number | null
          id?: string
          issued_date?: string | null
          license_number?: string | null
          license_type?: string
          notes?: string | null
          renewal_link?: string | null
          report_due_date?: string | null
          state_code?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "license_registry_state_code_fkey"
            columns: ["state_code"]
            isOneToOne: false
            referencedRelation: "state_regulation_rules"
            referencedColumns: ["state_code"]
          },
        ]
      }
      match_queue: {
        Row: {
          contest_template_id: string
          entry_fee_cents: number
          id: string
          joined_at: string
          matched_at: string | null
          picks: Json
          pool_id: string | null
          state_code: string
          status: string
          tier_id: string
          user_id: string
        }
        Insert: {
          contest_template_id: string
          entry_fee_cents: number
          id?: string
          joined_at?: string
          matched_at?: string | null
          picks: Json
          pool_id?: string | null
          state_code: string
          status?: string
          tier_id: string
          user_id: string
        }
        Update: {
          contest_template_id?: string
          entry_fee_cents?: number
          id?: string
          joined_at?: string
          matched_at?: string | null
          picks?: Json
          pool_id?: string | null
          state_code?: string
          status?: string
          tier_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_queue_contest_template_id_fkey"
            columns: ["contest_template_id"]
            isOneToOne: false
            referencedRelation: "contest_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_queue_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "contest_pools"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_sessions: {
        Row: {
          amount_cents: number
          checkout_url: string | null
          client_token: string | null
          completed_at: string | null
          created_at: string
          expires_at: string | null
          id: string
          metadata: Json | null
          provider: string
          provider_session_id: string | null
          state_code: string | null
          status: string
          user_id: string
        }
        Insert: {
          amount_cents: number
          checkout_url?: string | null
          client_token?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          provider: string
          provider_session_id?: string | null
          state_code?: string | null
          status?: string
          user_id: string
        }
        Update: {
          amount_cents?: number
          checkout_url?: string | null
          client_token?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          provider?: string
          provider_session_id?: string | null
          state_code?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      privacy_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          metadata: Json | null
          status: string
          type: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          status?: string
          type: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          status?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          age_confirmed_at: string | null
          city: string | null
          contest_count: number
          created_at: string
          date_of_birth: string | null
          deposit_limit_monthly: number | null
          email: string
          full_name: string | null
          id: string
          is_active: boolean
          is_beginner: boolean | null
          is_employee: boolean
          kyc_status: string
          kyc_verified_at: string | null
          phone: string | null
          self_exclusion_type: string | null
          self_exclusion_until: string | null
          state: string | null
          updated_at: string
          username: string | null
          username_last_changed_at: string | null
          withdrawal_last_requested_at: string | null
          zip_code: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          age_confirmed_at?: string | null
          city?: string | null
          contest_count?: number
          created_at?: string
          date_of_birth?: string | null
          deposit_limit_monthly?: number | null
          email: string
          full_name?: string | null
          id: string
          is_active?: boolean
          is_beginner?: boolean | null
          is_employee?: boolean
          kyc_status?: string
          kyc_verified_at?: string | null
          phone?: string | null
          self_exclusion_type?: string | null
          self_exclusion_until?: string | null
          state?: string | null
          updated_at?: string
          username?: string | null
          username_last_changed_at?: string | null
          withdrawal_last_requested_at?: string | null
          zip_code?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          age_confirmed_at?: string | null
          city?: string | null
          contest_count?: number
          created_at?: string
          date_of_birth?: string | null
          deposit_limit_monthly?: number | null
          email?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          is_beginner?: boolean | null
          is_employee?: boolean
          kyc_status?: string
          kyc_verified_at?: string | null
          phone?: string | null
          self_exclusion_type?: string | null
          self_exclusion_until?: string | null
          state?: string | null
          updated_at?: string
          username?: string | null
          username_last_changed_at?: string | null
          withdrawal_last_requested_at?: string | null
          zip_code?: string | null
        }
        Relationships: []
      }
      race_results_imports: {
        Row: {
          admin_id: string
          contest_template_id: string
          created_at: string
          errors: Json | null
          file_hash: string | null
          id: string
          import_date: string
          metadata: Json | null
          regatta_name: string
          results_data: Json
          rows_processed: number
          status: string
        }
        Insert: {
          admin_id: string
          contest_template_id: string
          created_at?: string
          errors?: Json | null
          file_hash?: string | null
          id?: string
          import_date?: string
          metadata?: Json | null
          regatta_name: string
          results_data: Json
          rows_processed?: number
          status?: string
        }
        Update: {
          admin_id?: string
          contest_template_id?: string
          created_at?: string
          errors?: Json | null
          file_hash?: string | null
          id?: string
          import_date?: string
          metadata?: Json | null
          regatta_name?: string
          results_data?: Json
          rows_processed?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_results_imports_contest_template_id_fkey"
            columns: ["contest_template_id"]
            isOneToOne: false
            referencedRelation: "contest_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          identifier: string
          request_count: number
          window_start: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          identifier: string
          request_count?: number
          window_start?: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          identifier?: string
          request_count?: number
          window_start?: string
        }
        Relationships: []
      }
      responsible_gaming: {
        Row: {
          created_at: string
          deposit_limit_monthly_cents: number | null
          self_exclusion_until: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deposit_limit_monthly_cents?: number | null
          self_exclusion_until?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deposit_limit_monthly_cents?: number | null
          self_exclusion_until?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "responsible_gaming_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      state_regulation_rules: {
        Row: {
          created_at: string
          head_to_head_allowed: boolean
          id: string
          last_verified_at: string
          license_required: boolean
          min_age: number
          min_contestants: number
          notes: string | null
          parlay_allowed: boolean
          pickem_allowed: boolean
          requires_skill_predominance: boolean
          state_code: string
          state_name: string
          status: string
          tax_rate: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          head_to_head_allowed?: boolean
          id?: string
          last_verified_at?: string
          license_required?: boolean
          min_age?: number
          min_contestants?: number
          notes?: string | null
          parlay_allowed?: boolean
          pickem_allowed?: boolean
          requires_skill_predominance?: boolean
          state_code: string
          state_name: string
          status: string
          tax_rate?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          head_to_head_allowed?: boolean
          id?: string
          last_verified_at?: string
          license_required?: boolean
          min_age?: number
          min_contestants?: number
          notes?: string | null
          parlay_allowed?: boolean
          pickem_allowed?: boolean
          requires_skill_predominance?: boolean
          state_code?: string
          state_name?: string
          status?: string
          tax_rate?: number
          updated_at?: string
        }
        Relationships: []
      }
      support_tickets: {
        Row: {
          assigned_to: string | null
          created_at: string
          email: string
          id: string
          message: string
          metadata: Json | null
          priority: string
          status: string
          subject: string
          topic: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          email: string
          id?: string
          message: string
          metadata?: Json | null
          priority?: string
          status?: string
          subject: string
          topic: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          email?: string
          id?: string
          message?: string
          metadata?: Json | null
          priority?: string
          status?: string
          subject?: string
          topic?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          deposit_timestamp: string | null
          description: string | null
          id: string
          idempotency_key: string | null
          is_taxable: boolean
          metadata: Json | null
          reference_id: string | null
          reference_type: string | null
          state_code: string | null
          status: Database["public"]["Enums"]["transaction_status"]
          tax_year: number | null
          type: Database["public"]["Enums"]["transaction_type"]
          user_id: string
          wallet_id: string
        }
        Insert: {
          amount: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deposit_timestamp?: string | null
          description?: string | null
          id?: string
          idempotency_key?: string | null
          is_taxable?: boolean
          metadata?: Json | null
          reference_id?: string | null
          reference_type?: string | null
          state_code?: string | null
          status?: Database["public"]["Enums"]["transaction_status"]
          tax_year?: number | null
          type: Database["public"]["Enums"]["transaction_type"]
          user_id: string
          wallet_id: string
        }
        Update: {
          amount?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deposit_timestamp?: string | null
          description?: string | null
          id?: string
          idempotency_key?: string | null
          is_taxable?: boolean
          metadata?: Json | null
          reference_id?: string | null
          reference_type?: string | null
          state_code?: string | null
          status?: Database["public"]["Enums"]["transaction_status"]
          tax_year?: number | null
          type?: Database["public"]["Enums"]["transaction_type"]
          user_id?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      user_consents: {
        Row: {
          consented_at: string
          doc_slug: string
          id: string
          ip_address: unknown
          user_agent: string | null
          user_id: string
          version: number
        }
        Insert: {
          consented_at?: string
          doc_slug: string
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          user_id: string
          version: number
        }
        Update: {
          consented_at?: string
          doc_slug?: string
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          available_balance: number
          created_at: string
          id: string
          lifetime_deposits: number
          lifetime_winnings: number
          lifetime_withdrawals: number
          pending_balance: number
          updated_at: string
          user_id: string
        }
        Insert: {
          available_balance?: number
          created_at?: string
          id?: string
          lifetime_deposits?: number
          lifetime_winnings?: number
          lifetime_withdrawals?: number
          pending_balance?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          available_balance?: number
          created_at?: string
          id?: string
          lifetime_deposits?: number
          lifetime_winnings?: number
          lifetime_withdrawals?: number
          pending_balance?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_dedup: {
        Row: {
          event_type: string
          id: string
          ip_address: unknown
          metadata: Json | null
          provider: string
          received_at: string
        }
        Insert: {
          event_type: string
          id: string
          ip_address?: unknown
          metadata?: Json | null
          provider: string
          received_at?: string
        }
        Update: {
          event_type?: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          provider?: string
          received_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_create_contest:
        | {
            Args: {
              p_allow_overflow?: boolean
              p_crews: Json
              p_entry_fee_cents: number
              p_gender_category: string
              p_lock_time: string
              p_max_entries: number
              p_payout_structure?: Json
              p_regatta_name: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_allow_overflow?: boolean
              p_crews: Json
              p_entry_fee_cents: number
              p_entry_tiers?: Json
              p_gender_category: string
              p_lock_time: string
              p_max_entries: number
              p_payout_structure?: Json
              p_regatta_name: string
            }
            Returns: Json
          }
      admin_update_race_results: {
        Args: { p_contest_pool_id: string; p_results: Json }
        Returns: Json
      }
      admin_void_contest: { Args: { p_contest_pool_id: string }; Returns: Json }
      calculate_pool_scores: {
        Args: { p_contest_pool_id: string; p_official_margin_seconds: number }
        Returns: Json
      }
      check_deposit_limit: {
        Args: { p_amount: number; p_user_id: string }
        Returns: boolean
      }
      cleanup_old_rate_limits: { Args: never; Returns: undefined }
      cleanup_old_webhooks: { Args: never; Returns: undefined }
      clone_contest_pool: {
        Args: { p_original_pool_id: string }
        Returns: string
      }
      enter_contest_pool: {
        Args: { p_contest_pool_id: string; p_picks: Json }
        Returns: Json
      }
      get_user_balance: { Args: { target_user_id: string }; Returns: number }
      get_usernames: {
        Args: { user_ids: string[] }
        Returns: {
          user_id: string
          username: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      initiate_withdrawal_atomic: {
        Args: {
          _amount_cents: number
          _state_code: string
          _user_id: string
          _wallet_id: string
        }
        Returns: {
          allowed: boolean
          reason: string
          today_total: number
        }[]
      }
      settle_pool_payouts: {
        Args: { p_contest_pool_id: string }
        Returns: Json
      }
      update_wallet_balance: {
        Args: {
          _available_delta: number
          _lifetime_deposits_delta?: number
          _lifetime_winnings_delta?: number
          _lifetime_withdrawals_delta?: number
          _pending_delta: number
          _wallet_id: string
        }
        Returns: {
          available_balance: number
          pending_balance: number
          success: boolean
        }[]
      }
      user_in_pool: {
        Args: { _pool_id: string; _user_id: string }
        Returns: boolean
      }
      withdraw_contest_entry: {
        Args: { p_contest_pool_id: string }
        Returns: Json
      }
    }
    Enums: {
      app_role: "admin" | "user"
      transaction_status:
        | "pending"
        | "processing"
        | "completed"
        | "failed"
        | "cancelled"
      transaction_type:
        | "deposit"
        | "withdrawal"
        | "entry_fee"
        | "refund"
        | "payout"
        | "bonus"
        | "adjustment"
        | "entry_fee_hold"
        | "entry_fee_release"
        | "provider_fee"
        | "platform_fee"
        | "tax"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
      transaction_status: [
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ],
      transaction_type: [
        "deposit",
        "withdrawal",
        "entry_fee",
        "refund",
        "payout",
        "bonus",
        "adjustment",
        "entry_fee_hold",
        "entry_fee_release",
        "provider_fee",
        "platform_fee",
        "tax",
      ],
    },
  },
} as const
