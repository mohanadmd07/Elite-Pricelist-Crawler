-- Update Outbox function to include draftBody alongside suggestedDraftReply
CREATE OR REPLACE FUNCTION public.fn_enqueue_approval_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_event_type TEXT;
    v_payload JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_event_type := 'APPROVAL_RECEIVED';
    ELSE
        IF OLD.status IS DISTINCT FROM NEW.status THEN
            v_event_type := 'APPROVAL_STATUS_CHANGED';
        ELSE
            v_event_type := 'APPROVAL_UPDATED';
        END IF;
    END IF;

    -- Build client-safe payload for Firestore read model
    v_payload := jsonb_build_object(
        'id', NEW.id,
        'exchangeMessageId', NEW.exchange_message_id,
        'contentHash', NEW.content_hash,
        'conversationId', NEW.conversation_id,
        'receivedAt', NEW.received_at,
        'patientName', NEW.patient_name,
        'mrn', NEW.mrn,
        'bed', NEW.bed,
        'admissionType', NEW.admission_type,
        'physician', NEW.physician,
        'contractorRaw', NEW.contractor_raw,
        'contractorNormalized', NEW.contractor_normalized,
        'contractorOfficer', NEW.contractor_officer,
        'priceListYear', NEW.price_list_year,
        'diagnosis', NEW.diagnosis,
        'requestedServices', NEW.requested_services,
        'matchedProcedures', NEW.matched_procedures,
        'financialTerms', NEW.financial_terms,
        'status', NEW.status,
        'statusReasonArabic', NEW.status_reason_arabic,
        'stateTimestamps', NEW.state_timestamps,
        'suggestedDraftReply', NEW.suggested_draft_reply,
        'draftBody', NEW.suggested_draft_reply,
        'cmWhatsappMessage', NEW.cm_whatsapp_message,
        'hasReplies', NEW.has_replies,
        'hasExistingApproval', NEW.has_existing_approval,
        'isRefused', NEW.is_refused,
        'updatedAt', NEW.updated_at
    );

    INSERT INTO public.outbox (
        aggregate_type,
        aggregate_id,
        event_type,
        payload
    ) VALUES (
        'inpatient_approval',
        NEW.id,
        v_event_type,
        v_payload
    );

    RETURN NEW;
END;
$$;
