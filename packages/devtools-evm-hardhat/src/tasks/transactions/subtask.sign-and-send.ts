import { types } from '@/cli'
import { SUBTASK_LZ_SIGN_AND_SEND } from '@/constants'
import { formatOmniTransaction } from '@/transactions/format'
import { createGnosisSignerFactory, createSignerFactory } from '@/transactions/signer'
import {
    type OmniSignerFactory,
    type OmniTransaction,
    type OmniTransactionWithError,
    type OmniTransactionWithReceipt,
    type SignAndSendResult,
    createSignAndSend,
} from '@layerzerolabs/devtools'
import {
    createLogger,
    createModuleLogger,
    pluralizeNoun,
    printBoolean,
    printJson,
    promptToContinue,
} from '@layerzerolabs/io-devtools'
import { createProgressBar, printRecords, render } from '@layerzerolabs/io-devtools/swag'
import { subtask } from 'hardhat/config'
import type { ActionType } from 'hardhat/types'

export interface SignAndSendTaskArgs {
    ci?: boolean
    transactions: OmniTransaction[]
    useSafe?: boolean
    createSigner?: OmniSignerFactory
}

const action: ActionType<SignAndSendTaskArgs> = async ({
    ci,
    transactions,
    useSafe = false,
    // useSafe will override createSigner using Gnosis factory
    createSigner = useSafe ? createGnosisSignerFactory() : createSignerFactory(),
}): Promise<SignAndSendResult> => {
    // We only want to be asking users for input if we are not in interactive mode
    const isInteractive = !ci

    const logger = createLogger()
    const subtaskLogger = createModuleLogger(SUBTASK_LZ_SIGN_AND_SEND)

    // Ask them whether they want to see them
    const previewTransactions = isInteractive
        ? await promptToContinue(`Would you like to preview the transactions before continuing?`)
        : true
    if (previewTransactions) {
        printRecords(transactions.map(formatOmniTransaction))
    }

    // Now ask the user whether they want to go ahead with signing them
    //
    // If they don't, we'll just return the list of pending transactions
    const shouldSubmit = isInteractive
        ? await promptToContinue(`Would you like to submit the required transactions?`)
        : true
    if (!shouldSubmit) {
        return subtaskLogger.verbose(`User cancelled the operation, exiting`), [[], [], transactions]
    }

    subtaskLogger.verbose(`Signing and sending transactions:\n\n${printJson(transactions)}`)

    // The last step is to execute those transactions
    //
    // For now we are only allowing sign & send using the accounts confgiured in hardhat config
    const signAndSend = createSignAndSend(createSigner)

    // We'll use these variables to store the state of signing
    let transactionsToSign: OmniTransaction[] = transactions
    let successfulTransactions: OmniTransactionWithReceipt[] = []
    let errors: OmniTransactionWithError[] = []

    // We will run an infinite retry loop when signing the transactions
    //
    // This loop will be broken in these scenarios:
    // - if all the transactions succeed
    // - if some of the transactions fail
    //      - in the interactive mode, if the user decides not to retry the failed transactions
    //      - in the non-interactive mode
    //
    // eslint-disable-next-line no-constant-condition
    while (true) {
        // Now we render a progressbar to monitor the task progress
        const progressBar = render(
            createProgressBar({ before: 'Signing... ', after: ` 0/${transactionsToSign.length}` })
        )

        subtaskLogger.verbose(`Sending the transactions`)
        const [successfulBatch, errorsBatch, pendingBatch] = await signAndSend(
            transactionsToSign,
            (result, results) => {
                // We'll keep updating the progressbar as we sign the transactions
                progressBar.rerender(
                    createProgressBar({
                        progress: results.length / transactionsToSign.length,
                        before: 'Signing... ',
                        after: ` ${results.length}/${transactionsToSign.length}`,
                    })
                )
            }
        )

        // And finally we drop the progressbar and continue
        progressBar.clear()

        // Now let's update the accumulators
        //
        // We'll append the successful transactions
        successfulTransactions = [...successfulTransactions, ...successfulBatch]
        // Overwrite the errrors
        //
        // We might in future return the error history but for now the last errors are okay
        errors = errorsBatch
        // And we update the array of transactions with the ones that did not make it through
        transactionsToSign = pendingBatch

        subtaskLogger.verbose(`Sent the transactions`)
        subtaskLogger.debug(`Successfully sent the following transactions:\n\n${printJson(successfulBatch)}`)
        subtaskLogger.debug(`Failed to send the following transactions:\n\n${printJson(errorsBatch)}`)
        subtaskLogger.debug(`Did not send the following transactions:\n\n${printJson(pendingBatch)}`)

        // Let the user know about the results of the batch
        logger.info(
            pluralizeNoun(
                successfulBatch.length,
                `Successfully sent 1 transaction`,
                `Successfully sent ${successfulBatch.length} transactions`
            )
        )

        // If there are no errors, we break out of the loop immediatelly
        if (errors.length === 0) {
            logger.info(`${printBoolean(true)} Your OApp is now configured`)

            break
        }

        // Now we bring the bad news to the user
        logger.error(
            pluralizeNoun(errors.length, `Failed to send 1 transaction`, `Failed to send ${errors.length} transactions`)
        )

        const previewErrors = isInteractive
            ? await promptToContinue(`Would you like to preview the failed transactions?`)
            : true
        if (previewErrors) {
            printRecords(
                errors.map(({ error, transaction }) => ({
                    error: String(error),
                    ...formatOmniTransaction(transaction),
                }))
            )
        }

        // We'll ask the user if they want to retry if we're in interactive mode
        //
        // If they decide not to, we exit, if they want to retry we start the loop again
        const retry = isInteractive ? await promptToContinue(`Would you like to retry?`, true) : false
        if (!retry) {
            logger.error(`${printBoolean(false)} Failed to configure the OApp`)

            break
        }
    }

    return [successfulTransactions, errors, transactionsToSign]
}

subtask(SUBTASK_LZ_SIGN_AND_SEND, 'Sign and send a list of transactions using a local signer', action)
    .addFlag('ci', 'Continuous integration (non-interactive) mode. Will not ask for any input from the user')
    .addParam('transactions', 'List of OmniTransaction objects', undefined, types.any)
    .addParam('createSigner', 'Function that creates a signer for a particular network', undefined, types.any, true)
    .addParam('useSafe', 'Use Gnosis Safe for signing.  Overrides createSigner.', false, types.boolean, true)
