/**
 * Utility per WhatsApp - Lead-to-WhatsApp Automation
 * Funzioni di supporto per la verifica e gestione di errori WhatsApp
 */

// Codici di errore WhatsApp e le relative cause
const WA_ERROR_CODES = {
    '131047': {
        cause: 'numero_bloccato',
        desc: 'Il numero ha bloccato il bot o ha impostato restrizioni privacy',
        canRetry: false,
        isUserError: true
    },
    '131026': {
        cause: 'template_invalido',
        desc: 'Template non valido o parametri incorretti',
        canRetry: false,
        isUserError: false
    },
    '131021': {
        cause: 'rate_limit',
        desc: 'Rate limit raggiunto per questo numero',
        canRetry: true,
        isUserError: false
    },
    '131054': {
        cause: 'numero_non_valido',
        desc: 'Numero non valido o non ha WhatsApp',
        canRetry: false,
        isUserError: true
    },
    '130429': {
        cause: 'rate_limit_app',
        desc: "Rate limit dell'applicazione raggiunto",
        canRetry: true,
        isUserError: false
    }
};

/**
 * Analizza gli errori di WhatsApp e determina la causa e se è possibile riprovare
 * @param {Object} status - L'oggetto status restituito da WhatsApp
 * @returns {Object} - Informazioni sull'errore e se può essere riprovato
 */
function analyzeWhatsAppError(status) {
    // Oggetto di ritorno con valori predefiniti
    const result = {
        canRetry: true,
        cause: 'sconosciuta',
        desc: 'Errore sconosciuto',
        isUserError: false,
        rawError: null
    };

    if (!status) return result;

    // Se abbiamo un errore con codice, cerchiamo nel dizionario
    if (status.errors && status.errors.length > 0) {
        const error = status.errors[0];
        const errCode = error.code?.toString();

        result.rawError = error;

        if (errCode && WA_ERROR_CODES[errCode]) {
            const errorInfo = WA_ERROR_CODES[errCode];
            result.cause = errorInfo.cause;
            result.desc = errorInfo.desc;
            result.canRetry = errorInfo.canRetry;
            result.isUserError = errorInfo.isUserError;
        } else {
            // Errore sconosciuto, estrai le informazioni disponibili
            result.desc = error.title ? `${error.title}: ${error.description || ''}` : error.message || 'Errore sconosciuto';

            // Potremmo tentare una ripetizione se non è noto come errore permanente
            result.canRetry = !error.code?.includes('131047') && !error.code?.includes('131054');
        }
    }
    // Per gli errori "undelivered" (telefono spento, no internet)
    else if (status.status === 'undelivered') {
        result.cause = 'non_recapitato';
        result.desc = 'Messaggio non consegnato al dispositivo (telefono spento o senza connessione)';
        result.canRetry = true;
        result.isUserError = false;
    }
    // Per gli errori "failed" generici
    else if (status.status === 'failed') {
        result.cause = 'invio_fallito';
        result.desc = 'Invio fallito per un errore generico';
        result.canRetry = true;
        result.isUserError = false;
    }

    return result;
}

/**
 * Determina la strategia di reinvio in base al tipo di errore
 * @param {Object} errorAnalysis - L'analisi dell'errore
 * @param {Object} leadData - I dati del lead
 * @returns {Object} - Strategia di reinvio (delay, max tentativi)
 */
function getRetryStrategy(errorAnalysis, leadData = {}) {
    const retryCount = leadData.retryCount || 0;

    // Nessun retry per errori utente permanenti o dopo troppi tentativi
    if (!errorAnalysis.canRetry || retryCount >= 3) {
        return {
            shouldRetry: false,
            delay: 0,
            reason: !errorAnalysis.canRetry
                ? 'errore_permanente'
                : 'max_tentativi_superati'
        };
    }

    // Strategia basata sul numero di tentativi precedenti
    let delay = 0;

    if (retryCount === 0) {
        // Primo tentativo: riprova dopo 4 ore (è più probabile che sia un problema temporaneo)
        delay = 4 * 60 * 60 * 1000; // 4 ore
    } else if (retryCount === 1) {
        // Secondo tentativo: riprova dopo 24 ore
        delay = 24 * 60 * 60 * 1000; // 24 ore
    } else {
        // Terzo tentativo: riprova dopo 3 giorni
        delay = 3 * 24 * 60 * 60 * 1000; // 3 giorni
    }

    return {
        shouldRetry: true,
        delay,
        nextRetry: Date.now() + delay,
        retryCount: retryCount + 1,
        reason: errorAnalysis.cause
    };
}

/**
 * Formatta un messaggio di errore per la notifica all'utente
 * @param {Object} error - L'oggetto errore analizzato 
 * @param {Object} retryInfo - Informazioni sul tentativo di reinvio
 * @returns {String} - Messaggio formattato
 */
function formatErrorMessage(error, retryInfo) {
    if (!error) return "Errore sconosciuto";

    let message = `${error.desc}`;

    if (retryInfo.shouldRetry) {
        // Se verrà riprovato, aggiungi info sul retry
        const retryDate = new Date(retryInfo.nextRetry);

        let timeframe;
        if (retryInfo.delay <= 5 * 60 * 60 * 1000) {
            // Meno di 5 ore
            timeframe = "fra poche ore";
        } else if (retryInfo.delay <= 25 * 60 * 60 * 1000) {
            // Circa 24 ore
            timeframe = "domani";
        } else {
            // Più di un giorno
            timeframe = `fra ${Math.round(retryInfo.delay / (24 * 60 * 60 * 1000))} giorni`;
        }

        message += ` (riproveremo ${timeframe})`;
    }

    return message;
}

export {
    analyzeWhatsAppError, formatErrorMessage, getRetryStrategy, WA_ERROR_CODES
};

